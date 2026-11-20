/**
 * Grupos de WhatsApp (solo gateway SMS Tools): grupos guardados del negocio y cola
 * de «agregar al cliente X al grupo Y». Nadie llama al gateway directo: todo pedido
 * (venta, botón, lote, flujo, agente, Copiloto) es una fila de WhatsappGroupMember.
 *
 * - Hay UNA cola por negocio y sale de a un número, nunca dos seguidos: minutos entre
 *   altas (30 de fábrica, mínimo 15), tope diario y horario (reglas en group-pacing.ts).
 *   Con un alta por minuto WhatsApp bloqueó el número; ningún camino se salta la cola.
 * - Prioridad por niveles: venta y cobro, luego presentación/agente/flujo, luego las
 *   altas a mano y al final el lote del CRM. `immediate` solo intenta salir ya si el
 *   hueco está cumplido.
 * - Antes de cada alta se consulta el grupo (groupinfo): suspendido o sin admin pausa
 *   ese grupo; quien ya es participante se marca sin llamar al gateway.
 * - Un 500 del gateway (bloqueo o cuenta desconectada) pausa las altas de TODO el
 *   negocio (24 h, o 30 min si está desconectada); 401/403/404 pausan el grupo.
 * - Número oculto: no va a groupadd; se le envía el link del grupo por mensaje.
 * - No hay reintentos automáticos, y quien salió del grupo no se vuelve a agregar.
 */

import { Prisma, WhatsappGroupAddSource, WhatsappGroupMemberStatus } from "@prisma/client";
import { AppError } from "../../lib/app-error";
import { prisma } from "../../lib/prisma";
import type { ProductGroupConfig } from "../../lib/product";
import { smsTools, type SmsToolsGroupAddResult, type SmsToolsGroupInfo } from "../../lib/smstools-client";
import { SOCKET_EVENTS, socketService } from "../../lib/socket";
import { notifyOwner, recordMessage, sendHumanReply } from "../agent/conversation.service";
import { applySpintax } from "../agent/reminder-templates";
import {
  BLOCK_PAUSE_MS,
  DEFAULT_GROUP_PACING,
  DISCONNECTED_RECHECK_MS,
  GROUP_PACING_LIMITS,
  SOURCE_TIERS,
  buildLinkMessage,
  estimateMinutes,
  isHiddenNumber,
  isInviteLink,
  nextAddWaitMs,
  tierOf,
  normalizePacing,
  pauseKindFor,
  pauseOf,
  type GroupHours,
  type GroupPacing,
  type GroupPause,
  type GroupPauseKind,
} from "./group-pacing";

const TRANSIENT_RETRY_MS = 5 * 60_000;
const STALE_CLAIM_MS = 10 * 60_000;

/** Estados en los que el cliente ya está (o ya fue invitado) y no hay nada que hacer. */
const SETTLED: WhatsappGroupMemberStatus[] = ["AGREGADO", "INVITADO", "YA_ESTABA"];
const IN_QUEUE: WhatsappGroupMemberStatus[] = ["PENDIENTE", "PROCESANDO"];

/** Candado en memoria por negocio: una sola alta a la vez, sea del grupo que sea. */
const processing = new Set<string>();

type Creds = { apiUrl: string; secret: string; account: string };

/** Credenciales del gateway si el canal del negocio es SMS Tools y está completo. */
export async function loadGroupCreds(companyId: string): Promise<Creds | null> {
  const wa = await prisma.whatsappConfig.findUnique({
    where: { companyId },
    select: { provider: true, apiUrl: true, secret: true, account: true, provisionPending: true },
  });
  if (!wa || wa.provider !== "SMSTOOLS" || wa.provisionPending || !wa.apiUrl || !wa.secret || !wa.account) return null;
  return { apiUrl: wa.apiUrl, secret: wa.secret, account: wa.account };
}

export async function requireGroupCreds(companyId: string): Promise<Creds> {
  const creds = await loadGroupCreds(companyId);
  if (!creds) {
    throw new AppError("Los grupos de WhatsApp solo funcionan con el canal SMS Tools conectado.", 400);
  }
  return creds;
}

export async function groupsSupported(companyId: string): Promise<boolean> {
  return (await loadGroupCreds(companyId)) !== null;
}

export async function requireGroup(companyId: string, groupId: string) {
  const group = await prisma.whatsappGroup.findFirst({ where: { id: groupId, companyId } });
  if (!group) throw new AppError("Grupo no encontrado", 404);
  return group;
}

// ---------------------------------------------------------------------------
// Ritmo de altas (por negocio)
// ---------------------------------------------------------------------------

export { DEFAULT_GROUP_PACING, GROUP_PACING_LIMITS, estimateMinutes, normalizePacing, type GroupPacing };

function rawPacingObj(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
}

/** Ritmo, pausa de la cuenta y zona horaria del negocio en una sola lectura. */
async function loadQueueSettings(companyId: string, now = new Date()) {
  const [wa, company] = await Promise.all([
    prisma.whatsappConfig.findUnique({ where: { companyId }, select: { groupAddPacing: true } }),
    prisma.company.findUnique({ where: { id: companyId }, select: { timezone: true } }),
  ]);
  return {
    raw: wa?.groupAddPacing ?? null,
    pacing: normalizePacing(wa?.groupAddPacing),
    pause: pauseOf(wa?.groupAddPacing, now),
    timeZone: company?.timezone || "America/Lima",
  };
}

export async function loadGroupPacing(companyId: string): Promise<GroupPacing> {
  return (await loadQueueSettings(companyId)).pacing;
}

/** Pausa vigente de las altas del negocio (bloqueo de 24 h o cuenta desconectada). */
export async function loadGroupPause(companyId: string): Promise<GroupPause | null> {
  return (await loadQueueSettings(companyId)).pause;
}

export async function saveGroupPacing(
  companyId: string,
  patch: { gapMinutes?: number; perDay?: number; hours?: Partial<GroupHours> },
): Promise<GroupPacing> {
  await requireGroupCreds(companyId);
  const { raw, pacing } = await loadQueueSettings(companyId);
  const next = normalizePacing({ ...pacing, ...patch, hours: { ...pacing.hours, ...(patch.hours ?? {}) } });
  // La pausa de la cuenta vive en el mismo JSON: guardar el ritmo no la borra.
  const keep = rawPacingObj(raw);
  const stored = {
    ...next,
    ...(typeof keep.pausedUntil === "string" ? { pausedUntil: keep.pausedUntil, pauseKind: keep.pauseKind, pauseReason: keep.pauseReason } : {}),
  };
  await prisma.whatsappConfig.update({ where: { companyId }, data: { groupAddPacing: stored as Prisma.InputJsonValue } });
  return next;
}

/**
 * Detiene las altas de TODO el negocio (no de un grupo). Un 500 del gateway es señal de
 * bloqueo de WhatsApp: se espera 24 h. La cola sigue aceptando pedidos y al terminar
 * retoma con el mismo espaciado. Avisa al dueño una sola vez por pausa.
 */
async function pauseAccount(companyId: string, kind: GroupPauseKind, reason: string): Promise<void> {
  const now = new Date();
  const { raw, pacing } = await loadQueueSettings(companyId, now);
  const prev = rawPacingObj(raw);
  // Reaviso solo si es una pausa nueva (la de «desconectado» se renueva cada 30 min en silencio).
  const prevUntil = typeof prev.pausedUntil === "string" ? new Date(prev.pausedUntil).getTime() : 0;
  const renewing = prev.pauseKind === kind && now.getTime() - prevUntil < 2 * DISCONNECTED_RECHECK_MS;
  const until = new Date(now.getTime() + (kind === "desconectado" ? DISCONNECTED_RECHECK_MS : BLOCK_PAUSE_MS));
  await prisma.whatsappConfig.update({
    where: { companyId },
    data: { groupAddPacing: { ...pacing, pausedUntil: until.toISOString(), pauseKind: kind, pauseReason: reason } as Prisma.InputJsonValue },
  });
  socketService.emitToCompany(companyId, SOCKET_EVENTS.GROUP_UPDATED, { members: true });
  if (renewing) return;
  void notifyOwner(
    companyId,
    kind === "desconectado"
      ? `⚠️ *Altas a grupos en espera*\nTu WhatsApp está desconectado. Vuelve a conectarlo en Canales → WhatsApp: las altas pendientes se retoman solas, espaciadas.`
      : `⚠️ *Altas a grupos en pausa por 24 horas*\nWhatsApp rechazó un alta. ${reason}\nPara cuidar tu número no se agrega a nadie hasta mañana. Los pedidos nuevos quedan en cola y saldrán espaciados.`,
  ).catch(() => undefined);
}

/** «Reanudar ahora»: quita la pausa de la cuenta. El hueco entre altas se sigue respetando. */
export async function resumeAccount(companyId: string): Promise<{ pacing: GroupPacing; pause: null }> {
  await requireGroupCreds(companyId);
  const { pacing } = await loadQueueSettings(companyId);
  await prisma.whatsappConfig.update({ where: { companyId }, data: { groupAddPacing: pacing as Prisma.InputJsonValue } });
  return { pacing, pause: null };
}

/** Altas enviadas al gateway por el negocio en la última hora y en las últimas 24 h. */
export async function groupAddUsage(companyId: string, now = new Date()) {
  const [lastHour, lastDay, last] = await Promise.all([
    prisma.whatsappGroupMember.count({ where: { companyId, claimedAt: { gt: new Date(now.getTime() - 60 * 60_000) } } }),
    prisma.whatsappGroupMember.count({ where: { companyId, claimedAt: { gt: new Date(now.getTime() - 24 * 60 * 60_000) } } }),
    prisma.whatsappGroupMember.findFirst({
      where: { companyId, claimedAt: { not: null } },
      orderBy: { claimedAt: "desc" },
      select: { claimedAt: true },
    }),
  ]);
  return { lastHour, lastDay, lastAt: last?.claimedAt ?? null };
}

// ---------------------------------------------------------------------------
// Grupos guardados
// ---------------------------------------------------------------------------

type Counters = { agregados: number; invitados: number; pendientes: number; enEspera: number; fallidos: number };

function emptyCounters(): Counters {
  return { agregados: 0, invitados: 0, pendientes: 0, enEspera: 0, fallidos: 0 };
}

function addCount(c: Counters, status: WhatsappGroupMemberStatus, n: number) {
  if (status === "AGREGADO" || status === "YA_ESTABA") c.agregados += n;
  else if (status === "INVITADO") c.invitados += n;
  else if (status === "PENDIENTE" || status === "PROCESANDO") c.pendientes += n;
  else if (status === "EN_ESPERA") c.enEspera += n;
  else if (status === "FALLIDO") c.fallidos += n;
}

export async function listSavedGroups(companyId: string) {
  const [supported, groups, counts, settings, usage] = await Promise.all([
    groupsSupported(companyId),
    prisma.whatsappGroup.findMany({ where: { companyId }, orderBy: { createdAt: "asc" } }),
    prisma.whatsappGroupMember.groupBy({ by: ["groupId", "status"], where: { companyId }, _count: { _all: true } }),
    loadQueueSettings(companyId),
    groupAddUsage(companyId),
  ]);
  const pacing = settings.pacing;
  const byGroup = new Map<string, Counters>();
  for (const row of counts) {
    const c = byGroup.get(row.groupId) ?? emptyCounters();
    addCount(c, row.status, row._count._all);
    byGroup.set(row.groupId, c);
  }
  // No leídos del chat de grupo: mensajes ajenos posteriores a la última lectura.
  const unread = new Map<string, number>();
  await Promise.all(
    groups
      .filter((g) => g.chatEnabled)
      .map(async (g) =>
        unread.set(
          g.id,
          await prisma.whatsappGroupMessage.count({
            where: {
              groupId: g.id,
              kind: "MENSAJE",
              fromMe: false,
              ...(g.lastReadAt ? { createdAt: { gt: g.lastReadAt } } : {}),
            },
          }),
        ),
      ),
  );
  const totalPending = [...byGroup.values()].reduce((sum, c) => sum + c.pendientes, 0);
  return {
    supported,
    pacing,
    usage: { lastHour: usage.lastHour, lastDay: usage.lastDay, lastAt: usage.lastAt },
    // Pausa de la cuenta (bloqueo de 24 h o WhatsApp desconectado): la cola acepta pero no envía.
    pause: settings.pause ? { until: settings.pause.until, kind: settings.pause.kind, reason: settings.pause.reason } : null,
    queue: { pending: totalPending, etaMinutes: estimateMinutes(totalPending, pacing) },
    groups: groups.map((g) => {
      const counters = byGroup.get(g.id) ?? emptyCounters();
      return {
        id: g.id,
        gid: g.gid,
        name: g.name,
        pausedReason: g.pausedReason,
        pausedAt: g.pausedAt,
        nextBatchAt: g.nextBatchAt,
        counters,
        etaMinutes: estimateMinutes(counters.pendientes, pacing),
        inviteMessage: g.inviteMessage,
        inviteLink: g.inviteLink,
        chatEnabled: g.chatEnabled,
        isAdmin: g.isAdmin,
        announce: g.announce,
        avatarUrl: g.avatarUrl,
        participantCount: g.participantCount,
        lastMessageAt: g.lastMessageAt,
        lastMessagePreview: g.lastMessagePreview,
        unread: unread.get(g.id) ?? 0,
      };
    }),
  };
}

/** Grupos de la cuenta en vivo, marcando cuáles ya están guardados. */
export async function listAvailableGroups(companyId: string) {
  const creds = await requireGroupCreds(companyId);
  const [live, saved] = await Promise.all([
    smsTools.getGroups(creds, creds.account),
    prisma.whatsappGroup.findMany({ where: { companyId }, select: { id: true, gid: true } }),
  ]);
  const savedByGid = new Map(saved.map((g) => [g.gid, g.id]));
  return live.map((g) => ({ gid: g.gid, name: g.name, savedId: savedByGid.get(g.gid) ?? null }));
}

export async function saveGroup(companyId: string, data: { gid: string; name: string }) {
  await requireGroupCreds(companyId);
  return prisma.whatsappGroup.upsert({
    where: { companyId_gid: { companyId, gid: data.gid } },
    create: { companyId, gid: data.gid, name: data.name },
    update: { name: data.name },
  });
}

export async function removeGroup(companyId: string, groupId: string) {
  const group = await requireGroup(companyId, groupId);
  if (group.chatEnabled) {
    // Deja de vigilar el grupo en el gateway; si falla, se quita igual.
    const creds = await loadGroupCreds(companyId);
    if (creds) await smsTools.watchGroup(creds, creds.account, group.gid, false).catch(() => undefined);
  }
  await prisma.whatsappGroup.delete({ where: { id: groupId } });
}

export async function resumeGroup(companyId: string, groupId: string) {
  await requireGroup(companyId, groupId);
  return prisma.whatsappGroup.update({
    where: { id: groupId },
    data: { pausedReason: null, pausedAt: null, nextBatchAt: null },
  });
}

/** Tope del mensaje que acompaña la invitación. */
export const INVITE_MESSAGE_MAX = 1000;

/** Guarda (o apaga, con texto vacío) el mensaje que acompaña la invitación del grupo. */
export async function saveInviteMessage(companyId: string, groupId: string, message: string | null) {
  await requireGroup(companyId, groupId);
  const text = (message ?? "").trim().slice(0, INVITE_MESSAGE_MAX);
  const saved = await prisma.whatsappGroup.update({
    where: { id: groupId },
    data: { inviteMessage: text || null },
    select: { id: true, name: true, inviteMessage: true, inviteLink: true },
  });
  return saved;
}

/**
 * Guarda (o quita, con vacío) el link de invitación del grupo. Lo copia el dueño desde
 * WhatsApp; se usa para invitar por mensaje a los clientes con número oculto.
 */
export async function saveInviteLink(companyId: string, groupId: string, link: string | null) {
  await requireGroup(companyId, groupId);
  const value = (link ?? "").trim();
  if (value && !isInviteLink(value)) {
    throw new AppError("El link debe ser el de invitación del grupo (empieza con https://chat.whatsapp.com/).", 400);
  }
  return prisma.whatsappGroup.update({
    where: { id: groupId },
    data: { inviteLink: value || null },
    select: { id: true, name: true, inviteMessage: true, inviteLink: true },
  });
}

/**
 * Limpia la configuración de grupo de un producto antes de guardarla: solo quedan
 * ids de grupos guardados de ESTE negocio. undefined = no tocar; null = sin grupos.
 */
export async function cleanProductGroupConfig(
  companyId: string,
  cfg: ProductGroupConfig | null | undefined,
): Promise<ProductGroupConfig | null | undefined> {
  if (cfg === undefined) return undefined;
  if (cfg === null) return null;
  const wanted = [cfg.onSale, cfg.onPresentation, cfg.onPayment].filter((v): v is string => Boolean(v));
  if (wanted.length === 0) return null;
  const rows = await prisma.whatsappGroup.findMany({ where: { companyId, id: { in: wanted } }, select: { id: true } });
  const valid = new Set(rows.map((r) => r.id));
  const out: ProductGroupConfig = {};
  if (cfg.onSale && valid.has(cfg.onSale)) out.onSale = cfg.onSale;
  if (cfg.onPresentation && valid.has(cfg.onPresentation)) out.onPresentation = cfg.onPresentation;
  if (cfg.onPayment && valid.has(cfg.onPayment)) out.onPayment = cfg.onPayment;
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------------------
// Miembros
// ---------------------------------------------------------------------------

const STATUS_FILTERS: Record<string, WhatsappGroupMemberStatus[]> = {
  agregados: ["AGREGADO", "YA_ESTABA"],
  invitados: ["INVITADO"],
  pendientes: ["PENDIENTE", "PROCESANDO"],
  enEspera: ["EN_ESPERA"],
  fallidos: ["FALLIDO"],
  cancelados: ["CANCELADO"],
};

export type MemberFilter = keyof typeof STATUS_FILTERS;

export async function listMembers(
  companyId: string,
  groupId: string,
  opts: { filter?: string; search?: string; page: number; pageSize: number },
) {
  await requireGroup(companyId, groupId);
  const search = opts.search?.trim();
  const where: Prisma.WhatsappGroupMemberWhereInput = {
    companyId,
    groupId,
    ...(opts.filter && STATUS_FILTERS[opts.filter] ? { status: { in: STATUS_FILTERS[opts.filter] } } : {}),
    ...(search
      ? {
          OR: [
            { phone: { contains: search.replace(/\D/g, "") || search } },
            { customer: { name: { contains: search, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.whatsappGroupMember.count({ where }),
    prisma.whatsappGroupMember.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (opts.page - 1) * opts.pageSize,
      take: opts.pageSize,
      include: { customer: { select: { id: true, name: true, phone: true, waIsLid: true } } },
    }),
  ]);
  return {
    total,
    page: opts.page,
    pageSize: opts.pageSize,
    items: rows.map((m) => ({
      id: m.id,
      customerId: m.customerId,
      name: m.customer.name,
      phone: m.customer.waIsLid ? null : m.customer.phone,
      status: m.status,
      source: m.source,
      attempts: m.attempts,
      lastResult: m.lastResult,
      lastCode: m.lastCode,
      nextAttemptAt: m.nextAttemptAt,
      resolvedAt: m.resolvedAt,
      createdAt: m.createdAt,
    })),
  };
}

/** Grupos de un contacto (chips de la pestaña Contacto). */
export async function listCustomerGroups(companyId: string, customerId: string) {
  const rows = await prisma.whatsappGroupMember.findMany({
    where: { companyId, customerId },
    orderBy: { createdAt: "asc" },
    include: { group: { select: { id: true, name: true } } },
  });
  return rows.map((m) => ({
    memberId: m.id,
    groupId: m.groupId,
    groupName: m.group.name,
    status: m.status,
    lastResult: m.lastResult,
    updatedAt: m.updatedAt,
  }));
}

export async function retryMembers(companyId: string, groupId: string, memberIds?: string[]) {
  await requireGroup(companyId, groupId);
  const res = await prisma.whatsappGroupMember.updateMany({
    where: {
      companyId,
      groupId,
      // Quien salió del grupo (EN_ESPERA) no se vuelve a agregar: WhatsApp lo castiga.
      status: { in: ["FALLIDO", "CANCELADO"] },
      ...(memberIds?.length ? { id: { in: memberIds } } : { status: "FALLIDO" }),
      // Un número que WhatsApp ya rechazó («failed») no se vuelve a enviar: insistir es lo
      // que termina en bloqueo. Sí se reintenta lo que falló por nuestro lado (p. ej.
      // faltaba el link de invitación del grupo).
      OR: [{ lastResult: null }, { lastResult: { notIn: ["failed", HIDDEN_NUMBER] } }, { status: "CANCELADO" }],
    },
    data: { status: "PENDIENTE", attempts: 0, nextAttemptAt: new Date(), immediate: false, recheck: false },
  });
  return { requeued: res.count };
}

export async function cancelPending(companyId: string, groupId: string) {
  await requireGroup(companyId, groupId);
  // Los que solo se estaban re-consultando vuelven a «invitado»; el resto se cancela.
  const back = await prisma.whatsappGroupMember.updateMany({
    where: { companyId, groupId, status: "PENDIENTE", recheck: true },
    data: { status: "INVITADO", recheck: false },
  });
  const res = await prisma.whatsappGroupMember.updateMany({
    where: { companyId, groupId, status: "PENDIENTE" },
    data: { status: "CANCELADO", resolvedAt: new Date() },
  });
  return { cancelled: res.count, restored: back.count };
}

/**
 * «Actualizar estado»: consulta los participantes del grupo (groupinfo) y marca como
 * agregado a cada invitado que ya entró. No reenvía números al gateway.
 */
export async function refreshInvited(companyId: string, groupId: string) {
  const group = await requireGroup(companyId, groupId);
  const creds = await requireGroupCreds(companyId);
  const info = await smsTools.getGroupInfo(creds, creds.account, group.gid);
  if (!info) throw new AppError("El proveedor no devolvió los datos del grupo.", 502);
  await prisma.whatsappGroup.update({ where: { id: groupId }, data: groupInfoData(info) });
  const updated = await settleParticipants(groupId, info);
  return { queued: 0, updated: updated.joined, etaMinutes: 0 };
}

// ---------------------------------------------------------------------------
// Encolar
// ---------------------------------------------------------------------------

export type EnqueueResult = {
  total: number;
  queued: number;
  skipped: { yaEnGrupo: number; enCola: number; noContactar: number; sinWhatsapp: number; salioDelGrupo: number; noEncontrados: number };
  etaMinutes: number;
};

/**
 * Encola clientes para un grupo. Omite visitantes web, «No contactar», los que ya
 * están o ya fueron invitados y los que ya esperan en la cola. `dryRun` solo cuenta.
 * `immediate` (un contacto suelto) va primero en la cola y sale al momento si hay cupo.
 */
export async function enqueueGroupAdd(opts: {
  companyId: string;
  groupId: string;
  customerIds: string[];
  source: WhatsappGroupAddSource;
  immediate?: boolean;
  dryRun?: boolean;
  /** Se conserva por compatibilidad de los llamadores; ya no fuerza a quien salió del grupo. */
  force?: boolean;
}): Promise<EnqueueResult> {
  const { companyId, groupId, source } = opts;
  await requireGroup(companyId, groupId);
  await requireGroupCreds(companyId);

  const ids = [...new Set(opts.customerIds)];
  const [customers, existing] = await Promise.all([
    prisma.customer.findMany({
      where: { companyId, id: { in: ids } },
      select: { id: true, phone: true, optOutAt: true },
    }),
    prisma.whatsappGroupMember.findMany({
      where: { groupId, customerId: { in: ids } },
      select: { customerId: true, status: true },
    }),
  ]);
  const existingBy = new Map(existing.map((m) => [m.customerId, m.status]));
  const skipped = { yaEnGrupo: 0, enCola: 0, noContactar: 0, sinWhatsapp: 0, salioDelGrupo: 0, noEncontrados: ids.length - customers.length };
  const toCreate: Prisma.WhatsappGroupMemberCreateManyInput[] = [];
  const toRequeue: string[] = [];
  const immediate = opts.immediate === true;

  for (const c of customers) {
    const digits = c.phone.replace(/\D/g, "");
    if (c.phone.startsWith("web:") || digits.length < 6) { skipped.sinWhatsapp += 1; continue; }
    if (c.optOutAt) { skipped.noContactar += 1; continue; }
    const prev = existingBy.get(c.id);
    if (prev && SETTLED.includes(prev)) { skipped.yaEnGrupo += 1; continue; }
    if (prev && IN_QUEUE.includes(prev)) { skipped.enCola += 1; continue; }
    // Salió del grupo: no se vuelve a agregar por ninguna vía, tampoco a pedido del dueño.
    if (prev === "EN_ESPERA") { skipped.salioDelGrupo += 1; continue; }
    if (prev) toRequeue.push(c.id);
    else toCreate.push({ companyId, groupId, customerId: c.id, phone: digits, source, immediate });
  }

  const queued = toCreate.length + toRequeue.length;
  if (!opts.dryRun && queued > 0) {
    if (toCreate.length) await prisma.whatsappGroupMember.createMany({ data: toCreate, skipDuplicates: true });
    if (toRequeue.length) {
      await prisma.whatsappGroupMember.updateMany({
        where: { groupId, customerId: { in: toRequeue }, status: { in: ["FALLIDO", "CANCELADO"] } },
        data: { status: "PENDIENTE", source, attempts: 0, nextAttemptAt: new Date(), immediate, recheck: false, resolvedAt: null },
      });
    }
  }
  let etaMinutes = 0;
  if (queued > 0) {
    // Solo espera detrás de lo que tiene igual o más prioridad (ventas primero, lote al final).
    const tier = tierOf(source);
    const aheadSources = SOURCE_TIERS.slice(0, tier + 1).flat() as WhatsappGroupAddSource[];
    const [pacing, ahead] = await Promise.all([
      loadGroupPacing(companyId),
      prisma.whatsappGroupMember.count({ where: { companyId, status: { in: IN_QUEUE }, source: { in: aheadSources } } }),
    ]);
    const pending = opts.dryRun ? ahead + queued : ahead;
    // Sola y con el hueco ya cumplido: sale ya (0). Si no, se estima la espera.
    const goesNow = immediate && pending <= 1 && (await quotaWaitMs(companyId)) === 0;
    etaMinutes = goesNow ? 0 : estimateMinutes(pending, pacing);
  }
  if (!opts.dryRun && queued > 0 && immediate) {
    // Sale al momento solo si el ritmo del negocio lo permite; si no, espera con prioridad.
    void processCompanyQueue(companyId, { single: true }).catch((err) =>
      console.error("[wa-groups] intento inmediato falló:", err instanceof Error ? err.message : err),
    );
  }
  return { total: ids.length, queued, skipped, etaMinutes };
}

/**
 * Alta automática (venta, presentación, cobro, flujo, agente): best-effort, nunca
 * lanza ni frena la entrega. Devuelve si quedó encolado.
 */
export async function autoGroupAdd(
  companyId: string,
  groupId: string | null | undefined,
  customerId: string,
  source: WhatsappGroupAddSource,
): Promise<{ ok: boolean; reason?: string; groupName?: string }> {
  if (!groupId) return { ok: false, reason: "sin_grupo" };
  try {
    const group = await prisma.whatsappGroup.findFirst({ where: { id: groupId, companyId }, select: { name: true } });
    if (!group) return { ok: false, reason: "grupo_no_existe" };
    const res = await enqueueGroupAdd({ companyId, groupId, customerIds: [customerId], source, immediate: true });
    if (res.queued > 0) return { ok: true, groupName: group.name };
    const reason = res.skipped.yaEnGrupo || res.skipped.enCola
      ? "ya_estaba"
      : res.skipped.noContactar
        ? "no_contactar"
        : res.skipped.salioDelGrupo
          ? "salio_del_grupo"
          : "sin_whatsapp";
    return { ok: reason === "ya_estaba", reason, groupName: group.name };
  } catch (err) {
    console.warn("[wa-groups] alta automática omitida:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "no_disponible" };
  }
}

const MOMENT_SOURCE = { onSale: "VENTA", onPresentation: "PRESENTACION", onPayment: "COBRO" } as const;

/**
 * Alta automática por producto para los caminos que no pasan por el agente (tienda
 * web, respuesta rápida): lee el grupo configurado en cada producto. Best-effort.
 */
export async function autoGroupAddForProducts(
  companyId: string,
  productIds: Array<string | null | undefined>,
  customerId: string | null | undefined,
  moment: keyof typeof MOMENT_SOURCE,
): Promise<void> {
  const ids = [...new Set(productIds.filter((v): v is string => Boolean(v)))];
  if (!customerId || ids.length === 0) return;
  try {
    const products = await prisma.product.findMany({
      where: { companyId, id: { in: ids } },
      select: { whatsappGroupConfig: true },
    });
    const groupIds = new Set<string>();
    for (const p of products) {
      const gid = (p.whatsappGroupConfig as ProductGroupConfig | null)?.[moment];
      if (gid) groupIds.add(gid);
    }
    for (const gid of groupIds) await autoGroupAdd(companyId, gid, customerId, MOMENT_SOURCE[moment]);
  } catch (err) {
    console.warn("[wa-groups] alta por producto omitida:", err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Despacho
// ---------------------------------------------------------------------------

const RESULT_STATUS: Record<string, WhatsappGroupMemberStatus> = {
  added: "AGREGADO",
  invite_sent: "INVITADO",
  already_in: "YA_ESTABA",
  cooldown: "EN_ESPERA",
};

/** Resultado propio: el gateway devolvió failed con código 400 (cliente con número oculto). */
const HIDDEN_NUMBER = "hidden_number";

/** Resultados propios del camino «número oculto»: invitación por mensaje con el link del grupo. */
const LINK_SENT = "link_sent";
const NO_INVITE_LINK = "no_invite_link";
const LINK_FAILED = "link_failed";

/** Estado del gateway dentro del AppError (envelope.status), si lo hay. */
function gatewayStatusOf(err: unknown): number | null {
  if (!(err instanceof AppError)) return null;
  const d = err.details as { status?: unknown } | null | undefined;
  return d && typeof d === "object" && typeof d.status === "number" ? d.status : null;
}

/** Motivo que el gateway adjunta al fallar (envelope.data.error), si lo hay. */
function gatewayErrorOf(err: unknown): string {
  if (!(err instanceof AppError)) return "";
  const d = err.details as { data?: unknown } | null | undefined;
  const data = d && typeof d === "object" ? d.data : null;
  const raw = data && typeof data === "object" ? (data as { error?: unknown }).error : null;
  return typeof raw === "string" ? raw.trim().slice(0, 200) : "";
}

function pauseReasonFor(status: number, message: string, detail = ""): string {
  if (/not connected/i.test(detail)) return "Tu WhatsApp está desconectado. Vuelve a conectarlo en Canales → WhatsApp.";
  if (status === 401) return "La API key de SMS Tools no es válida.";
  if (status === 403) return "La API key de SMS Tools no tiene permiso de envío (wa_send).";
  if (status === 404) return "SMS Tools no encontró la cuenta de WhatsApp. Revisa que siga conectada.";
  if (status === 500) {
    return detail
      ? `WhatsApp no dejó agregar participantes. Motivo que dio SMS Tools: ${detail}`
      : "WhatsApp no dejó agregar participantes y SMS Tools no indicó el motivo.";
  }
  return message || "El proveedor de WhatsApp rechazó la operación.";
}

async function noteInChat(companyId: string, customerId: string, text: string, silent = false): Promise<void> {
  const conv = await prisma.conversation.findFirst({
    where: { companyId, customerId, channel: "whatsapp" },
    orderBy: { lastMessageAt: "desc" },
    select: { id: true },
  });
  if (!conv) return;
  await recordMessage({
    companyId,
    customerId,
    conversationId: conv.id,
    role: "SYSTEM",
    message: text,
    rawPayload: { source: "wa-group" },
    silent,
  }).catch(() => undefined);
}

/** Origen de los mensajes de invitación (rawPayload.source). */
const INVITE_SOURCE = "wa-group-invite";

/**
 * Envía el mensaje propio del negocio tras la invitación de WhatsApp. Variables:
 * {nombre} y {grupo}; admite variantes {a|b}. Lleva la firma como todo mensaje
 * saliente. Nunca lanza: si falla, queda una nota en el chat y no se reintenta.
 */
async function sendInviteMessage(
  companyId: string,
  customerId: string,
  group: { name: string; inviteMessage: string | null },
): Promise<void> {
  const template = (group.inviteMessage ?? "").trim();
  if (!template) return;
  try {
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, companyId },
      select: { name: true, optOutAt: true },
    });
    if (!customer || customer.optOutAt) return;
    const conv = await prisma.conversation.findFirst({
      where: { companyId, customerId, channel: "whatsapp" },
      orderBy: { lastMessageAt: "desc" },
      select: { id: true },
    });
    if (!conv) return;
    const nombre = (customer.name ?? "").trim().split(/\s+/)[0] ?? "";
    const text = applySpintax(template)
      .replace(/\{nombre\}/gi, nombre)
      .replace(/\{grupo\}/gi, group.name)
      .replace(/[^\S\n]{2,}/g, " ")
      .replace(/[^\S\n]+([,.!?])/g, "$1")
      .trim();
    if (!text) return;
    await sendHumanReply(companyId, conv.id, text, { source: INVITE_SOURCE });
  } catch (err) {
    console.warn(`[wa-groups] mensaje de invitación falló (cliente ${customerId}): ${err instanceof Error ? err.message : err}`);
    void noteInChat(companyId, customerId, `👥 No se pudo enviar tu mensaje de invitación al grupo «${group.name}».`, true);
  }
}

/**
 * Invitación por mensaje con el link del grupo, para quien no se puede agregar por la
 * API (número oculto, o el gateway no pudo ni agregar ni mandar la tarjeta). Devuelve
 * el resultado para la fila de la cola. Nunca lanza.
 */
async function sendInviteLink(
  companyId: string,
  customerId: string,
  group: { name: string; inviteMessage: string | null; inviteLink: string | null },
): Promise<typeof LINK_SENT | typeof NO_INVITE_LINK | typeof LINK_FAILED> {
  const link = (group.inviteLink ?? "").trim();
  if (!isInviteLink(link)) return NO_INVITE_LINK;
  try {
    const customer = await prisma.customer.findFirst({ where: { id: customerId, companyId }, select: { name: true, optOutAt: true } });
    if (!customer || customer.optOutAt) return LINK_FAILED;
    const conv = await prisma.conversation.findFirst({
      where: { companyId, customerId, channel: "whatsapp" },
      orderBy: { lastMessageAt: "desc" },
      select: { id: true },
    });
    if (!conv) return LINK_FAILED;
    const nombre = (customer.name ?? "").trim().split(/\s+/)[0] ?? "";
    const text = buildLinkMessage(applySpintax(group.inviteMessage ?? ""), { nombre, grupo: group.name, link });
    await sendHumanReply(companyId, conv.id, text, { source: INVITE_SOURCE });
    return LINK_SENT;
  } catch (err) {
    console.warn(`[wa-groups] invitación por link falló (cliente ${customerId}): ${err instanceof Error ? err.message : err}`);
    return LINK_FAILED;
  }
}

function emitMembersChanged(companyId: string, groupId: string) {
  socketService.emitToCompany(companyId, SOCKET_EVENTS.GROUP_UPDATED, { groupId, members: true });
}

function groupInfoData(info: SmsToolsGroupInfo): Prisma.WhatsappGroupUpdateInput {
  return {
    participantCount: info.participantCount,
    isAdmin: info.isAdmin,
    announce: info.announce,
    participants: info.participants as unknown as Prisma.InputJsonValue,
    infoSyncedAt: new Date(),
  };
}

/**
 * Cruza la cola con los participantes reales del grupo: quien ya está no se envía al
 * gateway (pendiente → ya estaba) y el invitado que aceptó pasa a agregado.
 */
async function settleParticipants(groupId: string, info: SmsToolsGroupInfo) {
  const phones = [...new Set(info.participants.map((p) => p.phone).filter((p) => p.length >= 6))];
  if (phones.length === 0) return { already: 0, joined: 0 };
  const resolvedAt = new Date();
  // Invitados que ya entraron: se anota en su chat (sin moverlo en la lista).
  const accepted = await prisma.whatsappGroupMember.findMany({
    where: { groupId, status: "INVITADO", phone: { in: phones } },
    select: { companyId: true, customerId: true, group: { select: { name: true } } },
  });
  const [already, joined] = await Promise.all([
    prisma.whatsappGroupMember.updateMany({
      where: { groupId, status: "PENDIENTE", phone: { in: phones } },
      data: { status: "YA_ESTABA", lastResult: "already_in", lastCode: null, resolvedAt, immediate: false, recheck: false },
    }),
    prisma.whatsappGroupMember.updateMany({
      where: { groupId, status: "INVITADO", phone: { in: phones } },
      data: { status: "AGREGADO", lastResult: "joined", resolvedAt, recheck: false },
    }),
  ]);
  for (const m of accepted) {
    void noteInChat(m.companyId, m.customerId, `👥 Aceptó la invitación y entró al grupo «${m.group.name}».`, true);
  }
  return { already: already.count, joined: joined.count };
}

async function pauseGroup(group: { id: string; companyId: string; name: string }, reason: string): Promise<void> {
  await prisma.whatsappGroup.update({ where: { id: group.id }, data: { pausedReason: reason, pausedAt: new Date() } });
  emitMembersChanged(group.companyId, group.id);
  void notifyOwner(
    group.companyId,
    `⚠️ *Grupo de WhatsApp en pausa*\nNo se pudo agregar clientes al grupo «${group.name}».\n${reason}\nCuando lo corrijas, reanúdalo en Canales → WhatsApp → Grupos.`,
  ).catch(() => undefined);
}

/** Aparta al grupo unos minutos tras una caída o timeout del gateway. */
async function backoffGroup(groupId: string): Promise<void> {
  await prisma.whatsappGroup.update({
    where: { id: groupId },
    data: { nextBatchAt: new Date(Date.now() + TRANSIENT_RETRY_MS) },
  });
}

/**
 * Consulta previa a cada alta (la pide el gateway): grupo suspendido o cuenta sin
 * admin pausan la cola; los que ya son participantes se resuelven sin llamar.
 * Devuelve false si el grupo no puede recibir altas ahora.
 */
async function precheckGroup(
  group: { id: string; companyId: string; name: string; gid: string },
  creds: Creds,
  checked: Set<string>,
): Promise<boolean> {
  if (checked.has(group.id)) return true;
  let info: SmsToolsGroupInfo | null;
  try {
    info = await smsTools.getGroupInfo(creds, creds.account, group.gid);
  } catch (err) {
    const status = gatewayStatusOf(err);
    const message = err instanceof Error ? err.message : "Error del proveedor";
    const detail = gatewayErrorOf(err);
    if (status === 500) {
      // Señal de bloqueo (o cuenta desconectada): se detiene TODO el negocio, no solo el grupo.
      await pauseAccount(group.companyId, pauseKindFor(detail), pauseReasonFor(status, message, detail));
    } else if (status !== null && [401, 403, 404].includes(status)) {
      await pauseGroup(group, pauseReasonFor(status, message, detail));
    } else {
      await backoffGroup(group.id);
    }
    console.warn(`[wa-groups] groupinfo falló (grupo ${group.id}, estado ${status ?? "red"}): ${message}`);
    return false;
  }
  if (!info) {
    await pauseGroup(group, "SMS Tools no encontró el grupo. Puede que ya no exista o que tu número ya no esté en él.");
    return false;
  }
  await prisma.whatsappGroup.update({ where: { id: group.id }, data: groupInfoData(info) });
  if (info.suspended) {
    await pauseGroup(group, "WhatsApp suspendió este grupo: no se puede agregar a nadie.");
    return false;
  }
  if (!info.isAdmin) {
    await pauseGroup(group, "Tu número no es administrador de este grupo: no puede agregar participantes.");
    return false;
  }
  const settled = await settleParticipants(group.id, info);
  if (settled.already + settled.joined > 0) emitMembersChanged(group.companyId, group.id);
  checked.add(group.id);
  return true;
}

/**
 * Envía UN número al gateway: el siguiente pendiente del negocio (contactos sueltos
 * primero, luego el más antiguo). Devuelve true si la llamada salió bien.
 */
async function dispatchNext(companyId: string, creds: Creds, checked: Set<string>): Promise<boolean> {
  for (let guard = 0; guard < 10; guard += 1) {
    const now = new Date();
    const next = await nextInQueue(companyId, now);
    if (!next) return false;
    const group = next.group;

    // Número oculto: WhatsApp rechaza agregarlo por la API. Se le invita por mensaje con
    // el link del grupo, sin llamar al gateway de grupos. Ocupa su turno como un alta.
    if (isHiddenNumber(next.phone, next.customer.waIsLid)) {
      // Sin link guardado no hay nada que enviar: queda fallido con el motivo y NO gasta turno.
      if (!isInviteLink(group.inviteLink)) {
        const failed = await prisma.whatsappGroupMember.updateMany({
          where: { id: next.id, status: "PENDIENTE" },
          data: { status: "FALLIDO", lastResult: NO_INVITE_LINK, resolvedAt: now, immediate: false, recheck: false },
        });
        if (failed.count > 0) {
          emitMembersChanged(companyId, group.id);
          await noteInChat(
            companyId,
            next.customerId,
            `👥 No se pudo invitar al grupo «${group.name}»: su número está oculto y el grupo no tiene guardado el link de invitación (Canales → WhatsApp → Grupos).`,
            true,
          );
        }
        continue;
      }
      const claimHidden = await prisma.whatsappGroupMember.updateMany({
        where: { id: next.id, status: "PENDIENTE" },
        data: { status: "PROCESANDO", claimedAt: now },
      });
      if (claimHidden.count === 0) continue;
      await settleByLink(companyId, next, group);
      return true;
    }

    if (!(await precheckGroup(group, creds, checked))) {
      // Si la consulta previa detuvo la cuenta entera, no se sigue con otro grupo.
      if (await loadGroupPause(companyId)) return false;
      continue;
    }

    // Reclamo atómico: si la consulta previa ya lo resolvió (o alguien lo canceló), sigue otro.
    const claim = await prisma.whatsappGroupMember.updateMany({
      where: { id: next.id, status: "PENDIENTE" },
      data: { status: "PROCESANDO", claimedAt: now },
    });
    if (claim.count === 0) continue;

    let results: SmsToolsGroupAddResult[];
    try {
      results = await smsTools.addToGroup(creds, creds.account, group.gid, [next.phone], true);
    } catch (err) {
      const status = gatewayStatusOf(err);
      const message = err instanceof Error ? err.message : "Error del proveedor";
      const detail = gatewayErrorOf(err);
      const blocked = status === 500;
      const hard = status !== null && [401, 403, 404].includes(status);
      await prisma.whatsappGroupMember.update({
        where: { id: next.id },
        data: { status: "PENDIENTE", ...(hard || blocked ? {} : { nextAttemptAt: new Date(Date.now() + TRANSIENT_RETRY_MS) }) },
      });
      // 500 = WhatsApp rechazó (bloqueo) o cuenta desconectada: se detienen las altas del negocio.
      if (blocked) await pauseAccount(companyId, pauseKindFor(detail), pauseReasonFor(500, message, detail));
      else if (hard) await pauseGroup(group, pauseReasonFor(status!, message, detail));
      // Caída o timeout: reintentar es seguro (quien ya entró responde already_in).
      else await backoffGroup(group.id);
      console.warn(`[wa-groups] llamada falló (grupo ${group.id}, estado ${status ?? "red"}): ${message}${detail ? ` (${detail})` : ""}`);
      return false;
    }

    const r = results[0] ?? null;
    const code = typeof r?.code === "number" ? r.code : null;
    const hidden = r?.status === "failed" && code === 400;
    const raw = hidden ? HIDDEN_NUMBER : r?.status ?? "failed";
    // No se pudo agregar ni mandar la tarjeta (o resultó ser un número oculto): la
    // invitación sale por mensaje con el link del grupo.
    if (hidden || raw === "invite_failed") {
      await settleByLink(companyId, next, group, code);
      return true;
    }
    const status = RESULT_STATUS[raw] ?? null;
    const resolvedAt = new Date();
    const data: Prisma.WhatsappGroupMemberUpdateInput = {
      lastResult: raw,
      lastCode: code,
      recheck: false,
      immediate: false,
      attempts: next.attempts + 1,
    };
    if (status) {
      data.status = status;
      data.resolvedAt = resolvedAt;
    } else {
      // Un «failed» no se reintenta: insistir con el mismo número es lo que WhatsApp castiga.
      data.status = "FALLIDO";
      data.resolvedAt = resolvedAt;
    }
    await prisma.whatsappGroupMember.update({ where: { id: next.id }, data });
    emitMembersChanged(companyId, group.id);
    // Nota en el chat para contactos sueltos. La invitación se anota siempre (el dueño
    // no ve la tarjeta de WhatsApp en el panel), pero en silencio si viene de un lote:
    // no debe reordenar cientos de chats.
    if (next.immediate || status === "INVITADO") {
      const text =
        status === "AGREGADO"
          ? `👥 Agregado al grupo «${group.name}».`
          : status === "INVITADO"
            ? `👥 Invitación al grupo «${group.name}» enviada por WhatsApp (su privacidad no permite agregarlo directo). Entra cuando la acepte.`
            : status === "YA_ESTABA"
              ? null
              : status === "EN_ESPERA"
                ? `👥 No se pudo agregar al grupo «${group.name}»: salió del grupo hace poco.`
                : `👥 No se pudo agregar al grupo «${group.name}» (${raw}).`;
      if (text) await noteInChat(companyId, next.customerId, text, !next.immediate);
    }
    // Mensaje propio del negocio: una sola vez por persona y grupo (no en reintentos
    // de alguien a quien ya se le envió la invitación).
    if (status === "INVITADO" && next.lastResult !== "invite_sent") {
      void sendInviteMessage(companyId, next.customerId, group);
    }
    return true;
  }
  return false;
}

/**
 * Cuánto falta para que el ritmo del negocio permita otra alta: 0 = ya, null = tope
 * de la hora o del día alcanzado (se retoma solo cuando la ventana avanza).
 */
async function quotaWaitMs(companyId: string): Promise<number | null> {
  const now = new Date();
  const [settings, usage] = await Promise.all([loadQueueSettings(companyId, now), groupAddUsage(companyId, now)]);
  return nextAddWaitMs({
    pacing: settings.pacing,
    now,
    timeZone: settings.timeZone,
    lastAt: usage.lastAt,
    lastDay: usage.lastDay,
    paused: settings.pause !== null,
  });
}

type QueueRow = Prisma.WhatsappGroupMemberGetPayload<{
  include: {
    group: { select: { id: true; companyId: true; name: true; gid: true; inviteMessage: true; inviteLink: true } };
    customer: { select: { waIsLid: true } };
  };
}>;

/**
 * Siguiente pendiente del negocio por NIVELES: primero lo que se va vendiendo (venta y
 * cobro), luego presentación, agente y flujos, luego las altas a mano y al final el
 * lote del CRM. Dentro de cada nivel, el más antiguo.
 */
async function nextInQueue(companyId: string, now: Date): Promise<QueueRow | null> {
  for (const tier of SOURCE_TIERS) {
    const row = await prisma.whatsappGroupMember.findFirst({
      where: {
        companyId,
        status: "PENDIENTE",
        source: { in: [...tier] as WhatsappGroupAddSource[] },
        nextAttemptAt: { lte: now },
        group: { pausedReason: null, OR: [{ nextBatchAt: null }, { nextBatchAt: { lte: now } }] },
      },
      orderBy: { createdAt: "asc" },
      include: {
        group: { select: { id: true, companyId: true, name: true, gid: true, inviteMessage: true, inviteLink: true } },
        customer: { select: { waIsLid: true } },
      },
    });
    if (row) return row;
  }
  return null;
}

/** Resuelve una fila por el camino del link (número oculto o invitación fallida). */
async function settleByLink(companyId: string, next: QueueRow, group: QueueRow["group"], code: number | null = null): Promise<void> {
  const result = await sendInviteLink(companyId, next.customerId, group);
  const sent = result === LINK_SENT;
  await prisma.whatsappGroupMember.update({
    where: { id: next.id },
    data: {
      status: sent ? "INVITADO" : "FALLIDO",
      lastResult: result,
      lastCode: code,
      recheck: false,
      immediate: false,
      attempts: next.attempts + 1,
      resolvedAt: new Date(),
    },
  });
  emitMembersChanged(companyId, group.id);
  const text = sent
    ? `👥 Invitación al grupo «${group.name}» enviada por mensaje con el link (su número está oculto y no se puede agregar directo).`
    : result === NO_INVITE_LINK
      ? `👥 No se pudo invitar al grupo «${group.name}»: su número está oculto y el grupo no tiene guardado el link de invitación (Canales → WhatsApp → Grupos).`
      : `👥 No se pudo enviar la invitación al grupo «${group.name}».`;
  await noteInChat(companyId, next.customerId, text, true);
}

/**
 * Despacha la cola de un negocio respetando su ritmo: como máximo UNA alta por pasada
 * y solo si ya se cumplieron los minutos de espera. Devuelve cuántas altas salieron.
 */
export async function processCompanyQueue(companyId: string, opts?: { single?: boolean }): Promise<number> {
  if (processing.has(companyId)) return 0;
  processing.add(companyId);
  try {
    const creds = await loadGroupCreds(companyId);
    if (!creds) return 0;
    // UNA sola alta por pasada y solo si ya se cumplió el hueco, hay cupo del día, es
    // horario de altas y la cuenta no está en pausa. Nunca se espera dentro de la pasada.
    void opts;
    const wait = await quotaWaitMs(companyId);
    if (wait !== 0) return 0;
    return (await dispatchNext(companyId, creds, new Set<string>())) ? 1 : 0;
  } finally {
    processing.delete(companyId);
  }
}

/** Tick del worker: recupera reclamos colgados y despacha la cola de cada negocio. */
export async function runGroupQueueTick(): Promise<void> {
  const now = new Date();
  await prisma.whatsappGroupMember.updateMany({
    where: { status: "PROCESANDO", claimedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } },
    data: { status: "PENDIENTE" },
  });
  // Re-consultas del esquema anterior (invite=0): ya no viajan al gateway.
  await prisma.whatsappGroupMember.updateMany({
    where: { status: "PENDIENTE", recheck: true },
    data: { status: "INVITADO", recheck: false },
  });
  const due = await prisma.whatsappGroupMember.findMany({
    where: { status: "PENDIENTE", nextAttemptAt: { lte: now }, group: { pausedReason: null } },
    select: { companyId: true },
    distinct: ["companyId"],
    take: 200,
  });
  // Cada negocio lleva su propio ritmo: uno lento no frena a los demás.
  await Promise.all(
    due.map(({ companyId }) =>
      processCompanyQueue(companyId).catch((err) =>
        console.error("[wa-groups] cola falló:", err instanceof Error ? err.message : err),
      ),
    ),
  );
}
