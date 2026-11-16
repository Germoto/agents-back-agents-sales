/**
 * Chat de grupos de WhatsApp (solo gateway SMS Tools).
 *
 * Un grupo NO es un cliente: sus mensajes viven en WhatsappGroupMessage y nunca
 * tocan leads, CRM, métricas, recordatorios ni el bot. El chat de un grupo existe
 * solo si el dueño lo enciende (`chatEnabled`): eso marca el grupo como vigilado en
 * el gateway y desde ese momento llegan sus mensajes por webhook (sin historial).
 *
 * - No hay eco de lo que enviamos por API: el mensaje propio se guarda al enviar y
 *   su wamid se aprende del webhook de estados.
 * - El autor puede ser un número real o un pseudo-número LID: se guarda tal cual.
 */

import { Prisma, WhatsappGroup, WhatsappGroupMessage, WhatsappGroupMessageSender } from "@prisma/client";
import { AppError } from "../../lib/app-error";
import { prisma } from "../../lib/prisma";
import {
  smsTools,
  type GroupMessageEvent,
  type GroupParticipantEvent,
  type SmsToolsGroupInfo,
} from "../../lib/smstools-client";
import { socketService, SOCKET_EVENTS } from "../../lib/socket";
import { normalizeDeliveryStatus, notifyOwner } from "../agent/conversation.service";
import { applyFirma } from "../agent/firma";
import { loadWhatsappSender, sendMedia, sendPoll, sendText } from "../agent/outbound";
import { loadGroupCreds, requireGroup, requireGroupCreds } from "./whatsapp-groups.service";

/** Tope de mensajes AUTOMÁTICOS (flujo + Copiloto) por grupo y hora. El panel no tiene tope. */
export const GROUP_AUTO_HOURLY_CAP = 12;
const MESSAGES_PAGE = 50;
const DELIVERY_RANK: Record<string, number> = { pending: 0, unknown: 0, sent: 1, delivered: 2, read: 3 };

export type GroupParticipant = {
  phone: string;
  lid: string | null;
  name: string | null;
  isAdmin: boolean;
  isSuperadmin: boolean;
};

type Reaction = { phone: string; name: string | null; emoji: string };

function participantsOf(group: Pick<WhatsappGroup, "participants">): GroupParticipant[] {
  const raw = group.participants;
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[])
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p) => ({
      phone: String(p.phone ?? "").replace(/\D/g, ""),
      lid: typeof p.lid === "string" ? p.lid : null,
      name: typeof p.name === "string" ? p.name : null,
      isAdmin: p.isAdmin === true,
      isSuperadmin: p.isSuperadmin === true,
    }))
    .filter((p) => p.phone);
}

/** Tipo de adjunto según la extensión de la URL (lo desconocido viaja como documento). */
export function mediaKindFromUrl(url: string): "image" | "video" | "audio" | "document" {
  const u = url.toLowerCase().split(/[?#]/)[0];
  if (/\.(jpe?g|png|gif|webp)$/.test(u)) return "image";
  if (/\.(mp4|webm|3gp)$/.test(u)) return "video";
  if (/\.(ogg|opus|mp3|m4a|aac)$/.test(u)) return "audio";
  return "document";
}

function previewOf(text: string | null | undefined, mediaType?: string | null): string | null {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (clean) return clean.slice(0, 160);
  return mediaType ? `[${mediaType}]` : null;
}

function serializeMessage(m: WhatsappGroupMessage) {
  return {
    id: m.id,
    groupId: m.groupId,
    kind: m.kind,
    wamid: m.wamid,
    fromMe: m.fromMe,
    sentBy: m.sentBy,
    authorPhone: m.authorPhone,
    authorName: m.authorName,
    customerId: m.customerId,
    message: m.message,
    mediaUrl: m.mediaUrl,
    mediaType: m.mediaType,
    fileName: m.fileName,
    quotedWamid: m.quotedWamid,
    quotedPreview: m.quotedPreview,
    mentions: m.mentions ? m.mentions.split(",").filter(Boolean) : [],
    reactions: (Array.isArray(m.reactions) ? m.reactions : []) as unknown as Reaction[],
    poll: m.poll,
    eventData: m.eventData,
    deliveryStatus: m.deliveryStatus,
    starredAt: m.starredAt,
    createdAt: m.createdAt,
  };
}

export type GroupChatMessage = ReturnType<typeof serializeMessage>;

/** Mensajes ajenos posteriores a la última lectura del panel. */
async function unreadCount(group: Pick<WhatsappGroup, "id" | "lastReadAt" | "chatEnabled">): Promise<number> {
  if (!group.chatEnabled) return 0;
  return prisma.whatsappGroupMessage.count({
    where: {
      groupId: group.id,
      kind: "MENSAJE",
      fromMe: false,
      ...(group.lastReadAt ? { createdAt: { gt: group.lastReadAt } } : {}),
    },
  });
}

function emitGroupUpdated(group: Pick<WhatsappGroup, "id" | "companyId">, extra?: Record<string, unknown>) {
  socketService.emitToCompany(group.companyId, SOCKET_EVENTS.GROUP_UPDATED, { groupId: group.id, ...extra });
}

// ---------------------------------------------------------------------------
// Encender / apagar y datos del grupo
// ---------------------------------------------------------------------------

function infoData(info: SmsToolsGroupInfo): Prisma.WhatsappGroupUpdateInput {
  return {
    ...(info.name ? { name: info.name.slice(0, 120) } : {}),
    description: info.description,
    avatarUrl: info.avatarUrl,
    participantCount: info.participantCount,
    isAdmin: info.isAdmin,
    announce: info.announce,
    participants: info.participants as unknown as Prisma.InputJsonValue,
    infoSyncedAt: new Date(),
  };
}

/** Recarga nombre, descripción, admin, solo-admins y participantes desde el gateway. */
export async function syncGroupInfo(group: WhatsappGroup): Promise<WhatsappGroup> {
  const creds = await requireGroupCreds(group.companyId);
  const info = await smsTools.getGroupInfo(creds, creds.account, group.gid);
  if (!info) throw new AppError("El proveedor no devolvió los datos del grupo.", 502);
  return prisma.whatsappGroup.update({ where: { id: group.id }, data: infoData(info) });
}

/**
 * Enciende o apaga el chat de un grupo. Encender = vigilar el grupo en el gateway
 * (desde ahí llegan sus mensajes) y cargar sus datos. Apagar deja de vigilarlo; los
 * mensajes ya guardados se conservan.
 */
export async function setGroupChat(companyId: string, groupId: string, on: boolean) {
  const group = await requireGroup(companyId, groupId);
  const creds = await requireGroupCreds(companyId);
  if (on) {
    const watched = await smsTools.watchGroup(creds, creds.account, group.gid, true);
    if (!watched) {
      throw new AppError("WhatsApp no dejó activar el chat de este grupo. Revisa que tu número siga dentro del grupo.", 409);
    }
    const info = await smsTools.getGroupInfo(creds, creds.account, group.gid).catch(() => null);
    await prisma.whatsappGroup.update({
      where: { id: groupId },
      data: {
        chatEnabled: true,
        watchedAt: new Date(),
        // Sin historial: lo «no leído» cuenta desde que se enciende.
        ...(group.chatEnabled ? {} : { lastReadAt: new Date() }),
        ...(info ? infoData(info) : {}),
      },
    });
  } else {
    // Si el gateway falla al apagar, el chat se apaga igual: la barrera del receptor
    // descarta lo que llegue de un grupo con el chat apagado.
    await smsTools.watchGroup(creds, creds.account, group.gid, false).catch(() => undefined);
    await prisma.whatsappGroup.update({ where: { id: groupId }, data: { chatEnabled: false, watchedAt: null } });
  }
  emitGroupUpdated(group);
  return getGroupDetail(companyId, groupId);
}

/** Detalle del grupo con participantes; cada uno enlazado a su cliente si existe. */
export async function getGroupDetail(companyId: string, groupId: string, opts?: { refresh?: boolean }) {
  let group = await requireGroup(companyId, groupId);
  let stale = false;
  if (opts?.refresh) {
    try {
      group = await syncGroupInfo(group);
    } catch {
      stale = true; // se muestra lo último conocido
    }
  }
  const participants = participantsOf(group);
  const phones = participants.map((p) => p.phone);
  const customers = phones.length
    ? await prisma.customer.findMany({
        where: { companyId, phone: { in: [...phones, ...phones.map((p) => `+${p}`)] } },
        select: { id: true, name: true, phone: true },
      })
    : [];
  const byPhone = new Map(customers.map((c) => [c.phone.replace(/\D/g, ""), c]));
  return {
    id: group.id,
    gid: group.gid,
    name: group.name,
    description: group.description,
    avatarUrl: group.avatarUrl,
    chatEnabled: group.chatEnabled,
    isAdmin: group.isAdmin,
    announce: group.announce,
    participantCount: group.participantCount ?? participants.length,
    infoSyncedAt: group.infoSyncedAt,
    stale,
    unread: await unreadCount(group),
    participants: participants
      .map((p) => {
        const c = byPhone.get(p.phone);
        return { ...p, customerId: c?.id ?? null, customerName: c?.name ?? null };
      })
      .sort((a, b) => Number(b.isAdmin) - Number(a.isAdmin) || (a.customerName ?? a.name ?? a.phone).localeCompare(b.customerName ?? b.name ?? b.phone)),
  };
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

/** Mensajes por tramos, del más reciente hacia atrás (se devuelven en orden cronológico). */
export async function listGroupMessages(
  companyId: string,
  groupId: string,
  opts?: { before?: string | null; limit?: number; starred?: boolean },
) {
  await requireGroup(companyId, groupId);
  const limit = Math.min(Math.max(opts?.limit ?? MESSAGES_PAGE, 1), 100);
  let cursor: Date | null = null;
  if (opts?.before) {
    const ref = await prisma.whatsappGroupMessage.findFirst({
      where: { id: opts.before, groupId },
      select: { createdAt: true },
    });
    cursor = ref?.createdAt ?? null;
  }
  const rows = await prisma.whatsappGroupMessage.findMany({
    where: {
      groupId,
      ...(cursor ? { createdAt: { lt: cursor } } : {}),
      ...(opts?.starred ? { starredAt: { not: null } } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  return { messages: rows.slice(0, limit).reverse().map(serializeMessage), hasMore };
}

export async function markGroupRead(companyId: string, groupId: string) {
  const group = await requireGroup(companyId, groupId);
  await prisma.whatsappGroup.update({ where: { id: groupId }, data: { lastReadAt: new Date() } });
  emitGroupUpdated(group, { unread: 0 });
  return { ok: true };
}

export async function starGroupMessage(companyId: string, groupId: string, messageId: string, starred: boolean) {
  await requireGroup(companyId, groupId);
  const msg = await prisma.whatsappGroupMessage.findFirst({ where: { id: messageId, groupId }, select: { id: true } });
  if (!msg) throw new AppError("Mensaje no encontrado", 404);
  const starredAt = starred ? new Date() : null;
  await prisma.whatsappGroupMessage.update({ where: { id: messageId }, data: { starredAt } });
  socketService.emitToCompany(companyId, SOCKET_EVENTS.GROUP_MESSAGE_UPDATED, { groupId, id: messageId, starredAt });
  return { id: messageId, starredAt };
}

// ---------------------------------------------------------------------------
// Envío
// ---------------------------------------------------------------------------

export type GroupSendInput = {
  text?: string | null;
  mediaUrl?: string | null;
  mediaKind?: "image" | "video" | "audio" | "document" | "sticker" | null;
  fileName?: string | null;
  /** Id (nuestro) del mensaje del grupo que se cita. */
  quoteMessageId?: string | null;
  /** Números a mencionar (el texto debe traer @<número>). */
  mentions?: string[];
  poll?: { question: string; options: string[]; selectable?: number } | null;
};

/**
 * Envía un mensaje al grupo y lo guarda (no hay eco del gateway). `sentBy` distingue
 * al asesor en el panel de los envíos automáticos (flujo, Copiloto), que tienen tope
 * por hora para no inundar el grupo.
 */
export async function sendGroupMessage(
  companyId: string,
  groupId: string,
  input: GroupSendInput,
  sentBy: WhatsappGroupMessageSender = "PANEL",
): Promise<GroupChatMessage> {
  const group = await requireGroup(companyId, groupId);
  if (!group.chatEnabled) {
    throw new AppError("El chat de este grupo está apagado. Enciéndelo en Canales → WhatsApp → Grupos.", 409);
  }
  if (group.announce && group.isAdmin === false) {
    throw new AppError("En este grupo solo escriben los administradores y tu número no lo es.", 409);
  }
  const sender = await loadWhatsappSender(companyId);
  if (!sender || sender.provider !== "SMSTOOLS") {
    throw new AppError("El chat de grupos solo funciona con el canal SMS Tools conectado.", 422);
  }
  const rawText = (input.text ?? "").trim();
  if (!rawText && !input.mediaUrl && !input.poll) throw new AppError("El mensaje está vacío.", 400);

  if (sentBy === "FLUJO" || sentBy === "COPILOTO") {
    const recent = await prisma.whatsappGroupMessage.count({
      where: { groupId, sentBy: { in: ["FLUJO", "COPILOTO"] }, createdAt: { gt: new Date(Date.now() - 60 * 60_000) } },
    });
    if (recent >= GROUP_AUTO_HOURLY_CAP) {
      throw new AppError(
        `Tope de seguridad: ya se enviaron ${GROUP_AUTO_HOURLY_CAP} mensajes automáticos a este grupo en la última hora.`,
        429,
      );
    }
  }

  // Cita: wamid del mensaje citado + su autor ("me" si es propio).
  let quote: { wamid: string; from: string; preview: string | null } | null = null;
  if (input.quoteMessageId) {
    const quoted = await prisma.whatsappGroupMessage.findFirst({ where: { id: input.quoteMessageId, groupId } });
    if (!quoted) throw new AppError("El mensaje a citar no existe en este grupo", 404);
    if (!quoted.wamid) {
      throw new AppError("Aún no tengo el ID de WhatsApp de ese mensaje (llega con el ✓✓). Intenta en unos segundos.", 409);
    }
    quote = {
      wamid: quoted.wamid,
      from: quoted.fromMe ? "me" : (quoted.authorPhone ?? ""),
      preview: previewOf(quoted.message, quoted.mediaType),
    };
  }

  // Menciones: solo cuentan los números que de verdad aparecen como @<número> en el texto.
  const inText = new Set([...rawText.matchAll(/@(\d{6,16})/g)].map((m) => m[1]));
  const known = new Set([...participantsOf(group).map((p) => p.phone), ...(input.mentions ?? []).map((p) => p.replace(/\D/g, ""))]);
  const mentions = [...inText].filter((p) => known.has(p));
  const opts = {
    ...(quote ? { quoteWamid: quote.wamid, quoteFrom: quote.from } : {}),
    ...(mentions.length ? { mentions } : {}),
  };

  let gatewayId: string | null = null;
  let message: string | null = null;
  let mediaType: string | null = null;
  let poll: Prisma.InputJsonValue | undefined;
  if (input.poll) {
    const options = input.poll.options.map((o) => o.trim()).filter(Boolean);
    if (!input.poll.question.trim() || options.length < 2) throw new AppError("La encuesta necesita una pregunta y al menos 2 opciones.", 400);
    const sent = await sendPoll(sender, group.gid, { question: input.poll.question.trim(), options, selectable: input.poll.selectable });
    gatewayId = sent.gatewayId;
    message = input.poll.question.trim();
    poll = { question: message, options, selectable: Math.max(1, input.poll.selectable ?? 1) };
  } else if (input.mediaUrl) {
    const kind = input.mediaKind ?? "document";
    // Un sticker no lleva texto ni firma.
    const caption = kind === "sticker" ? undefined : ((await applyFirma(companyId, rawText || null)) ?? undefined);
    const sent = await sendMedia(sender, group.gid, kind, input.mediaUrl, caption, input.fileName ?? undefined, opts);
    gatewayId = sent.gatewayId;
    message = caption ?? null;
    mediaType = kind;
  } else {
    // Misma firma que el chat 1 a 1.
    message = (await applyFirma(companyId, rawText)) ?? rawText;
    const sent = await sendText(sender, group.gid, message, opts);
    gatewayId = sent.gatewayId;
  }

  const row = await prisma.whatsappGroupMessage.create({
    data: {
      companyId,
      groupId,
      fromMe: true,
      sentBy,
      message,
      mediaUrl: input.poll ? null : (input.mediaUrl ?? null),
      mediaType,
      fileName: mediaType === "document" ? (input.fileName ?? null) : null,
      quotedWamid: quote?.wamid ?? null,
      quotedPreview: quote?.preview ?? null,
      mentions: mentions.length ? mentions.join(",") : null,
      ...(poll ? { poll } : {}),
      gatewayId,
      deliveryStatus: gatewayId ? "pending" : null,
    },
  });
  await touchGroup(group, row);
  const dto = serializeMessage(row);
  socketService.emitToCompany(companyId, SOCKET_EVENTS.GROUP_MESSAGE_NEW, { groupId, message: dto });
  return dto;
}

async function touchGroup(group: Pick<WhatsappGroup, "id">, row: WhatsappGroupMessage) {
  const preview = row.poll ? `📊 ${row.message ?? "Encuesta"}` : previewOf(row.message, row.mediaType);
  await prisma.whatsappGroup.update({
    where: { id: group.id },
    data: { lastMessageAt: row.createdAt, lastMessagePreview: preview },
  });
}

// ---------------------------------------------------------------------------
// Sacar participantes
// ---------------------------------------------------------------------------

export async function removeParticipants(companyId: string, groupId: string, phones: string[]) {
  let group = await requireGroup(companyId, groupId);
  const creds = await requireGroupCreds(companyId);
  const targets = [...new Set(phones.map((p) => p.replace(/\D/g, "")).filter(Boolean))];
  if (!targets.length) throw new AppError("Indica a quién sacar del grupo.", 400);
  if (targets.length > 50) throw new AppError("Máximo 50 participantes por vez.", 400);
  // Sin admin el gateway responde 500: se confirma antes con el dato fresco.
  if (group.isAdmin !== true) group = await syncGroupInfo(group).catch(() => group);
  if (group.isAdmin === false) throw new AppError("Tu número no es administrador de este grupo: no puede sacar participantes.", 409);

  const results = await smsTools.addToGroup(creds, creds.account, group.gid, targets, false, "remove");
  const failed = new Set(
    results
      .filter((r) => ["failed", "invite_failed"].includes(String(r.status ?? "")))
      .map((r) => String(r.phone ?? "").replace(/\D/g, "")),
  );
  const removed = targets.filter((p) => !failed.has(p));
  if (removed.length) {
    const left = participantsOf(group).filter((p) => !removed.includes(p.phone));
    await prisma.whatsappGroup.update({
      where: { id: groupId },
      data: {
        participants: left as unknown as Prisma.InputJsonValue,
        ...(group.participantCount != null ? { participantCount: Math.max(0, group.participantCount - removed.length) } : {}),
      },
    });
    // Lo sacó el dueño: no vuelve a la cola por sí solo.
    await prisma.whatsappGroupMember.updateMany({
      where: { groupId, phone: { in: removed } },
      data: { status: "CANCELADO", lastResult: "removed", resolvedAt: new Date(), immediate: false, recheck: false },
    });
    emitGroupUpdated(group);
  }
  return { removed, failed: [...failed] };
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * Ubica el/los grupo(s) guardados de un webhook. Con la cuenta del gateway se
 * resuelve el negocio exacto; sin ella, por gid entre los grupos con chat encendido.
 */
async function findGroupsForWebhook(gid: string, account: string | null): Promise<WhatsappGroup[]> {
  if (account) {
    const cfg = await prisma.whatsappConfig.findFirst({
      where: { account, provider: "SMSTOOLS" },
      select: { companyId: true },
    });
    if (cfg) {
      const g = await prisma.whatsappGroup.findUnique({ where: { companyId_gid: { companyId: cfg.companyId, gid } } });
      return g ? [g] : [];
    }
  }
  return prisma.whatsappGroup.findMany({ where: { gid, chatEnabled: true } });
}

async function customerByPhone(companyId: string, phone: string) {
  if (!phone) return null;
  return prisma.customer.findFirst({
    where: { companyId, phone: { in: [phone, `+${phone}`] } },
    select: { id: true, name: true },
  });
}

function fileNameFromUrl(url: string): string | null {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    return name || null;
  } catch {
    return null;
  }
}

/** Mensaje (o reacción) recibido de un grupo vigilado. Nunca crea clientes ni turnos del bot. */
export async function handleGroupMessage(event: GroupMessageEvent): Promise<void> {
  const groups = await findGroupsForWebhook(event.gid, event.account);
  for (const group of groups) {
    if (!group.chatEnabled) continue;
    try {
      await storeGroupMessage(group, event);
    } catch (err) {
      console.warn(`[wa-group-chat] mensaje descartado (grupo ${group.id}):`, err instanceof Error ? err.message : err);
    }
  }
}

async function storeGroupMessage(group: WhatsappGroup, event: GroupMessageEvent): Promise<void> {
  const participant = participantsOf(group).find((p) => p.phone === event.authorPhone) ?? null;
  const authorName = event.authorName ?? participant?.name ?? null;

  // Reacción: se suma al mensaje reaccionado, no es un mensaje nuevo.
  const reactionMatch = /^\[reacci[oó]n\]\s*(.*)$/i.exec(event.text.trim());
  if (event.targetWamid || reactionMatch) {
    if (!event.targetWamid) return;
    const target = await prisma.whatsappGroupMessage.findFirst({
      where: { groupId: group.id, OR: [{ wamid: event.targetWamid }, { gatewayId: event.targetWamid }] },
    });
    if (!target) return;
    const emoji = (reactionMatch ? reactionMatch[1] : event.text).trim();
    const who = event.fromMe ? "me" : event.authorPhone;
    const current = (Array.isArray(target.reactions) ? target.reactions : []) as unknown as Reaction[];
    const next = current.filter((r) => r.phone !== who);
    if (emoji) next.push({ phone: who, name: event.fromMe ? null : authorName, emoji });
    await prisma.whatsappGroupMessage.update({
      where: { id: target.id },
      data: { reactions: next as unknown as Prisma.InputJsonValue },
    });
    socketService.emitToCompany(group.companyId, SOCKET_EVENTS.GROUP_MESSAGE_UPDATED, {
      groupId: group.id,
      id: target.id,
      reactions: next,
    });
    return;
  }

  if (!event.text.trim() && !event.mediaUrl) return;
  if (event.wamid) {
    const dup = await prisma.whatsappGroupMessage.findFirst({
      where: { groupId: group.id, wamid: event.wamid },
      select: { id: true },
    });
    if (dup) return;
  }
  const customer = event.fromMe ? null : await customerByPhone(group.companyId, event.authorPhone);
  let quotedPreview: string | null = null;
  if (event.quotedWamid) {
    const quoted = await prisma.whatsappGroupMessage.findFirst({
      where: { groupId: group.id, OR: [{ wamid: event.quotedWamid }, { gatewayId: event.quotedWamid }] },
      select: { message: true, mediaType: true },
    });
    quotedPreview = quoted ? previewOf(quoted.message, quoted.mediaType) : null;
  }
  let row: WhatsappGroupMessage;
  try {
    row = await prisma.whatsappGroupMessage.create({
      data: {
        companyId: group.companyId,
        groupId: group.id,
        wamid: event.wamid,
        fromMe: event.fromMe,
        sentBy: event.fromMe ? "TELEFONO" : null,
        authorPhone: event.authorPhone || null,
        authorName: event.fromMe ? null : authorName,
        customerId: customer?.id ?? null,
        message: event.text.trim() || null,
        mediaUrl: event.mediaUrl,
        mediaType: event.mediaType,
        fileName: event.mediaType === "document" && event.mediaUrl ? fileNameFromUrl(event.mediaUrl) : null,
        quotedWamid: event.quotedWamid,
        quotedPreview,
        mentions: event.mentions.length ? event.mentions.join(",") : null,
        ...(event.timestamp && event.timestamp.getTime() <= Date.now() ? { createdAt: event.timestamp } : {}),
      },
    });
  } catch (err) {
    // Reintento del gateway en paralelo: el índice único (groupId, wamid) lo frena.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return;
    throw err;
  }
  await touchGroup(group, row);
  socketService.emitToCompany(group.companyId, SOCKET_EVENTS.GROUP_MESSAGE_NEW, {
    groupId: group.id,
    groupName: group.name,
    message: serializeMessage(row),
  });
}

function label(phone: string, names: Map<string, string>): string {
  return names.get(phone) ?? `+${phone}`;
}

function eventText(event: GroupParticipantEvent, names: Map<string, string>): string {
  const who = event.phones.map((p) => label(p, names)).join(", ") || "Alguien";
  const by = event.by && !event.phones.includes(event.by) ? label(event.by, names) : null;
  const plural = event.phones.length > 1;
  switch (event.action) {
    case "join":
      if (by) return `${by} agregó a ${who}`;
      return event.reason === "invite"
        ? `${who} ${plural ? "entraron" : "entró"} con el enlace de invitación`
        : `${who} ${plural ? "entraron" : "entró"} al grupo`;
    case "leave":
      return by ? `${by} sacó a ${who}` : `${who} ${plural ? "salieron" : "salió"} del grupo`;
    case "promote":
      return `${who} ahora ${plural ? "son administradores" : "es administrador"}`;
    case "demote":
      return `${who} ya no ${plural ? "son administradores" : "es administrador"}`;
    default:
      if (event.name) return `El grupo ahora se llama «${event.name}»`;
      if (event.topic !== null) return "Se cambió la descripción del grupo";
      return "Se actualizaron los datos del grupo";
  }
}

/** Evento de participantes o de datos del grupo: línea de sistema + lista al día + cola de miembros. */
export async function handleGroupEvent(event: GroupParticipantEvent): Promise<void> {
  const groups = await findGroupsForWebhook(event.gid, event.account);
  for (const group of groups) {
    try {
      await applyGroupEvent(group, event);
    } catch (err) {
      console.warn(`[wa-group-chat] evento descartado (grupo ${group.id}):`, err instanceof Error ? err.message : err);
    }
  }
}

async function applyGroupEvent(group: WhatsappGroup, event: GroupParticipantEvent): Promise<void> {
  let participants = participantsOf(group);
  const names = new Map<string, string>();
  for (const p of participants) if (p.name) names.set(p.phone, p.name);
  const involved = [...event.phones, ...(event.by ? [event.by] : [])];
  if (involved.length) {
    const customers = await prisma.customer.findMany({
      where: { companyId: group.companyId, phone: { in: [...involved, ...involved.map((p) => `+${p}`)] } },
      select: { name: true, phone: true },
    });
    for (const c of customers) if (c.name) names.set(c.phone.replace(/\D/g, ""), c.name);
  }

  const data: Prisma.WhatsappGroupUpdateInput = {};
  if (event.action === "join") {
    const have = new Set(participants.map((p) => p.phone));
    for (const phone of event.phones) {
      if (!have.has(phone)) participants.push({ phone, lid: null, name: names.get(phone) ?? null, isAdmin: false, isSuperadmin: false });
    }
    // Aceptó la invitación (o lo agregaron a mano): ya está dentro.
    await prisma.whatsappGroupMember.updateMany({
      where: { groupId: group.id, phone: { in: event.phones }, status: { in: ["INVITADO", "PENDIENTE", "EN_ESPERA", "FALLIDO"] } },
      data: { status: "AGREGADO", lastResult: "joined", resolvedAt: new Date(), immediate: false, recheck: false },
    });
  } else if (event.action === "leave") {
    participants = participants.filter((p) => !event.phones.includes(p.phone));
    // Salió: no se vuelve a agregar solo.
    await prisma.whatsappGroupMember.updateMany({
      where: { groupId: group.id, phone: { in: event.phones }, status: { in: ["AGREGADO", "YA_ESTABA", "INVITADO"] } },
      data: { status: "EN_ESPERA", lastResult: "left", resolvedAt: new Date(), immediate: false, recheck: false },
    });
  } else if (event.action === "promote" || event.action === "demote") {
    const admin = event.action === "promote";
    participants = participants.map((p) =>
      event.phones.includes(p.phone) ? { ...p, isAdmin: admin, isSuperadmin: admin ? p.isSuperadmin : false } : p,
    );
  } else {
    if (event.name) data.name = event.name.slice(0, 120);
    if (event.topic !== null) data.description = event.topic || null;
  }
  if (event.action !== "update") {
    data.participants = participants as unknown as Prisma.InputJsonValue;
    data.participantCount = participants.length;
  }
  if (Object.keys(data).length) await prisma.whatsappGroup.update({ where: { id: group.id }, data });

  if (group.chatEnabled) {
    const row = await prisma.whatsappGroupMessage.create({
      data: {
        companyId: group.companyId,
        groupId: group.id,
        kind: "EVENTO",
        message: eventText(event, names),
        eventData: { action: event.action, phones: event.phones, by: event.by, reason: event.reason },
        ...(event.timestamp && event.timestamp.getTime() <= Date.now() ? { createdAt: event.timestamp } : {}),
      },
    });
    socketService.emitToCompany(group.companyId, SOCKET_EVENTS.GROUP_MESSAGE_NEW, {
      groupId: group.id,
      message: serializeMessage(row),
    });
  }
  emitGroupUpdated(group);
  // El evento no dice si la cuenta sigue siendo admin ni si fue ella quien salió:
  // se confirma con el dato fresco del gateway.
  scheduleInfoCheck(group.id, event.action === "leave");
}

const infoTimers = new Map<string, NodeJS.Timeout>();

/** Recarga los datos del grupo poco después de un evento (una sola vez por ráfaga). */
function scheduleInfoCheck(groupId: string, afterLeave: boolean) {
  const prev = infoTimers.get(groupId);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    infoTimers.delete(groupId);
    void checkGroupAfterEvent(groupId, afterLeave).catch(() => undefined);
  }, 4_000);
  timer.unref?.();
  infoTimers.set(groupId, timer);
}

async function checkGroupAfterEvent(groupId: string, afterLeave: boolean): Promise<void> {
  const group = await prisma.whatsappGroup.findUnique({ where: { id: groupId } });
  if (!group || !group.chatEnabled) return;
  const creds = await loadGroupCreds(group.companyId);
  if (!creds) return;
  let gone = false;
  try {
    const info = await smsTools.getGroupInfo(creds, creds.account, group.gid);
    if (info) {
      await prisma.whatsappGroup.update({ where: { id: groupId }, data: infoData(info) });
      // Si la cuenta sale del grupo, el gateway deja de vigilarlo por sí solo.
      gone = afterLeave && !info.watched;
    }
  } catch (err) {
    const d = err instanceof AppError ? (err.details as { status?: unknown } | null | undefined) : null;
    const status = d && typeof d === "object" && typeof d.status === "number" ? d.status : null;
    gone = afterLeave && status !== null && [400, 403, 404].includes(status);
  }
  if (gone) {
    await prisma.whatsappGroup.update({ where: { id: groupId }, data: { chatEnabled: false, watchedAt: null } });
    void notifyOwner(
      group.companyId,
      `⚠️ *Chat de grupo apagado*\nTu número ya no está en el grupo «${group.name}», así que su chat se apagó en el panel.\nSi vuelves a entrar, enciéndelo en Canales → WhatsApp → Grupos.`,
    ).catch(() => undefined);
  }
  emitGroupUpdated(group);
}

/**
 * Estado de entrega de un mensaje enviado a un grupo (solo llega el primer
 * «entregado» y el primer «leído»). Aprende el wamid y solo sube de estado.
 */
export async function applyGroupDeliveryStatus(ids: Array<string | null>, rawStatus: string): Promise<boolean> {
  const status = normalizeDeliveryStatus(rawStatus);
  const keys = ids.filter((v): v is string => !!v && v.trim().length > 0);
  if (!status || !keys.length) return false;
  const msg = await prisma.whatsappGroupMessage.findFirst({
    where: { OR: [{ gatewayId: { in: keys } }, { wamid: { in: keys } }] },
    select: { id: true, companyId: true, groupId: true, deliveryStatus: true, wamid: true },
  });
  if (!msg) return false;
  const learnedWamid = !msg.wamid ? keys.find((k) => !/^\d+$/.test(k)) ?? null : null;
  const current = msg.deliveryStatus ?? "pending";
  const isUpgrade =
    status === "failed"
      ? !["delivered", "read", "failed"].includes(current)
      : (DELIVERY_RANK[status] ?? 0) > (DELIVERY_RANK[current] ?? -1);
  if (!isUpgrade && !learnedWamid) return false;
  const data = { ...(isUpgrade ? { deliveryStatus: status } : {}), ...(learnedWamid ? { wamid: learnedWamid } : {}) };
  try {
    await prisma.whatsappGroupMessage.update({ where: { id: msg.id }, data });
  } catch (err) {
    // El wamid ya existe en otro mensaje del grupo: se aplica solo el estado.
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") || !isUpgrade) return false;
    await prisma.whatsappGroupMessage.update({ where: { id: msg.id }, data: { deliveryStatus: status } });
  }
  socketService.emitToCompany(msg.companyId, SOCKET_EVENTS.GROUP_MESSAGE_UPDATED, {
    groupId: msg.groupId,
    id: msg.id,
    ...(isUpgrade ? { deliveryStatus: status } : {}),
    ...(learnedWamid ? { wamid: learnedWamid } : {}),
  });
  return isUpgrade;
}
