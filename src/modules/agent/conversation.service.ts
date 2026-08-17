/**
 * Persistencia de conversaciones del agente.
 *
 * Reemplaza el `staticData.customers` de n8n: cada cliente (por telefono) tiene
 * un Customer + una Conversation con `state` (JSON) y un historial real de
 * ConversationMessage que se le pasa a OpenAI cada turno.
 */

import { Prisma, ConversationRole, ScheduledMessageType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { cancelPendingReminders, scheduleReminder } from "../scheduler/scheduler.service";
import { env } from "../../config/env";
import { AppError } from "../../lib/app-error";
import { socketService, SOCKET_EVENTS } from "../../lib/socket";
import { deleteCustomer } from "../customers/customers.service";
import { loadWhatsappSender, sendText, sendMedia, sendReaction, webSender } from "./outbound";
import { applyFirma } from "./firma";
import { resolveAdDescriptions, adInfoFor } from "../ad-catalog/ad-catalog.service";
import type { ChatMessage } from "../../lib/openai";

/** Estado conversacional persistido en Conversation.state (equivalente al customer.* de n8n). */
export interface ConversationState {
  status?: string;            // NUEVO, INTERESADO, ESPERANDO_PAGO, ENTREGADO, etc.
  selectedProductId?: string | null;
  /** Pedido pendiente de pago recién registrado (para marcarlo PAGADO al aprobar el pago). */
  pendingOrderId?: string | null;
  /** Resumen del carrito REAL, refrescado en cada turno (rubros de carrito). */
  cartText?: string | null;
  // Oferta ESCALONADA activada por recordatorio: precio personal de ESTE cliente
  // (el agente lo ofrece/cobra/valida). La escribe el scheduler.worker al enviar
  // un step con offerPrice; se limpia al aprobar el pago.
  activeOffer?: { productId?: string | null; priceText: string; at?: string; source?: string } | null;
  lastPaymentPromptAt?: string | null;
  pendingAction?: string | null;
  offerExpiresAt?: string | null;
  /** Productos cuya ficha ya se envió en esta conversación (evita reenviarla). */
  presentedProductIds?: string[];
  /** Productos cuya multimedia ya se envió en esta conversación. */
  mediaSentProductIds?: string[];
  /** Producto relacionado (cross-sell) ofrecido tras la última entrega; da contexto al agente. */
  offeredCrossSellProductId?: string | null;
  /** Memoria durable: productos que el cliente YA compró y recibió (de comprobantes APROBADOS).
   *  Se recalcula cada turno; no depende del historial reciente (los últimos 16 mensajes). */
  purchasedProductIds?: string[];
  /** Datos leídos del último comprobante (visión): monto, hora, N° operación y código de seguridad. */
  lastReceipt?: {
    amountText?: string | null;
    time?: string | null;
    operationNumber?: string | null;
    securityCode?: string | null;
    mediaUrl?: string | null;
    at?: string;
  } | null;
  /** Si hay un reintento de validación de pago agendado (evita duplicar el PAYMENT_RECHECK). */
  pendingRecheckAt?: string | null;
  /** La auto-validación (al llegar la imagen) ya gestionó el pago; el turno del modelo no debe re-hacerlo. */
  receiptAutoHandledAt?: string | null;
  /** Intentos fallidos de validación por falta de dato (Plin sin nombre): tras 3 se deriva a un asesor. */
  paymentAttempts?: number;
  /** SIMULACIÓN: productIds del combo capturados al validar pago (el carrito se cierra antes de entregar). */
  pendingDeliveryProductIds?: string[];
  /** Mercado Pago: preference del último link de pago enviado y su monto (para el webhook). */
  mpPreferenceId?: string | null;
  mpAmount?: number | null;
  [key: string]: unknown;
}

export interface LoadedConversation {
  customerId: string;
  conversationId: string;
  state: ConversationState;
  botPaused: boolean;
  lastInboundId: string | null;
  /** true si el Customer se creó en esta llamada (lead nuevo → enriquecer). */
  isNewCustomer: boolean;
}

export function normalizePhone(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.startsWith("+") ? digits : `+${digits}`;
}

/**
 * Resuelve (o crea) el Customer y la Conversation para un telefono entrante.
 * Devuelve null si el inbound ya fue procesado (idempotencia por messageId).
 */
export async function loadOrCreateConversation(
  companyId: string,
  fromPhone: string,
  inboundId: string | null,
): Promise<LoadedConversation> {
  const phone = normalizePhone(fromPhone);

  // find→upsert para saber si el lead es NUEVO (dispara el enriquecimiento).
  const existingCustomer = await prisma.customer.findUnique({
    where: { companyId_phone: { companyId, phone } },
    select: { id: true },
  });
  const customer = await prisma.customer.upsert({
    where: { companyId_phone: { companyId, phone } },
    update: { lastInteractionAt: new Date() },
    create: {
      companyId,
      phone,
      status: "activo",
      lastInteractionAt: new Date(),
      metadata: { origin: "agent-inbound" },
    },
    select: { id: true },
  });

  const conversation = await prisma.conversation.upsert({
    where: {
      companyId_customerId_channel: { companyId, customerId: customer.id, channel: "whatsapp" },
    },
    update: { lastMessageAt: new Date() },
    create: { companyId, customerId: customer.id, channel: "whatsapp", state: {} },
    select: { id: true, state: true, botPaused: true, lastInboundId: true },
  });

  return {
    customerId: customer.id,
    conversationId: conversation.id,
    state: (conversation.state as ConversationState) ?? {},
    botPaused: conversation.botPaused,
    lastInboundId: conversation.lastInboundId,
    isNewCustomer: !existingCustomer,
  };
}

/** Marca el ultimo inbound procesado (idempotencia). */
export async function markInboundProcessed(conversationId: string, inboundId: string | null) {
  if (!inboundId) return;
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastInboundId: inboundId },
  });
}

export async function saveState(conversationId: string, state: ConversationState) {
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { state: state as Prisma.InputJsonValue, lastMessageAt: new Date() },
  });
}

export async function setBotPaused(
  companyId: string,
  conversationId: string,
  paused: boolean,
  opts: { reason?: string | null } = {},
) {
  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: { botPaused: paused, status: paused ? "HUMAN" : "OPEN" },
    select: { customerId: true },
  });
  socketService.emitToCompany(companyId, SOCKET_EVENTS.CONVERSATION_UPDATED, {
    conversationId,
    botPaused: paused,
    // Motivo de la derivación (si vino de derivar_humano): el panel lo muestra
    // como toast para que la pausa nunca sea silenciosa (clave en chat web).
    ...(opts.reason ? { humanReason: opts.reason } : {}),
  });
  // Al pasar a atención humana (derivación, "tomar control" o muteado), cancelar
  // los recordatorios de seguimiento pendientes: no queremos que un bot moleste a
  // un cliente que ya está con una persona. PAYMENT_RECHECK se mantiene (interno).
  if (paused) {
    try {
      await cancelPendingReminders(companyId, updated.customerId, [
        ScheduledMessageType.ABANDONED_CART,
        ScheduledMessageType.LEFT_ON_READ,
        ScheduledMessageType.OFFER_COUNTDOWN,
        ScheduledMessageType.POST_SALE,
        ScheduledMessageType.CUSTOM,
        ScheduledMessageType.FLOW_TIMEOUT,
      ]);
    } catch (err) {
      console.warn("[agent] cancelar recordatorios al pausar falló:", err instanceof Error ? err.message : err);
    }
  }
}

/** Persiste un mensaje y emite el evento de tiempo real al panel. */
export async function recordMessage(opts: {
  companyId: string;
  customerId: string;
  conversationId: string;
  role: ConversationRole;
  message?: string | null;
  mediaUrl?: string | null;
  mediaType?: string | null;
  productId?: string | null;
  rawPayload?: Prisma.InputJsonValue;
  gatewayId?: string | null;
  deliveryStatus?: string | null;
  wamid?: string | null;
  quotedWamid?: string | null;
  quotedPreview?: string | null;
}): Promise<string> {
  const created = await prisma.conversationMessage.create({
    data: {
      companyId: opts.companyId,
      customerId: opts.customerId,
      conversationId: opts.conversationId,
      role: opts.role,
      message: opts.message ?? null,
      mediaUrl: opts.mediaUrl ?? null,
      mediaType: opts.mediaType ?? null,
      productId: opts.productId ?? null,
      gatewayId: opts.gatewayId ?? null,
      deliveryStatus: opts.deliveryStatus ?? null,
      wamid: opts.wamid ?? null,
      quotedWamid: opts.quotedWamid ?? null,
      quotedPreview: opts.quotedPreview ?? null,
      ...(opts.rawPayload !== undefined ? { rawPayload: opts.rawPayload } : {}),
    },
    select: { id: true, role: true, message: true, mediaUrl: true, mediaType: true, createdAt: true },
  });
  // Subir el chat al tope de la lista: TODO mensaje (entrante, del bot, del humano,
  // respuesta rápida o recordatorio) actualiza lastMessageAt. listConversations ordena
  // por este campo desc, así el panel se reordena en vivo.
  await prisma.conversation
    .update({ where: { id: opts.conversationId }, data: { lastMessageAt: created.createdAt } })
    .catch(() => undefined);
  socketService.emitToCompany(opts.companyId, SOCKET_EVENTS.MESSAGE_NEW, {
    conversationId: opts.conversationId,
    customerId: opts.customerId,
    id: created.id,
    role: created.role,
    message: created.message,
    mediaUrl: created.mediaUrl,
    mediaType: created.mediaType,
    createdAt: created.createdAt,
  });
  return created.id;
}

// ---------------------------------------------------------------------------
// Checks de entrega (webhook whatsapp_status / statuses de Meta) y reacciones
// ---------------------------------------------------------------------------
/** Escalera de estados: solo se hace UPGRADE (nunca read→delivered). */
const DELIVERY_RANK: Record<string, number> = { pending: 0, unknown: 0, sent: 1, delivered: 2, read: 3 };

/** Normaliza el estado del gateway a la escalera (played cuenta como leído). */
export function normalizeDeliveryStatus(status: string): string | null {
  const s = status.toLowerCase();
  if (s === "played") return "read";
  if (["sent", "delivered", "read"].includes(s)) return s;
  if (["failed", "error", "rejected", "undelivered"].includes(s)) return "failed";
  return null;
}

/**
 * Aplica un estado de entrega a un mensaje por su gatewayId (id del gateway o
 * wamid). Solo upgrade por rango; "failed" siempre gana sobre pending/sent.
 * Emite MESSAGE_UPDATED para refrescar los checks del panel en vivo.
 */
export async function applyDeliveryStatus(ids: Array<string | null>, rawStatus: string): Promise<boolean> {
  const status = normalizeDeliveryStatus(rawStatus);
  const keys = ids.filter((v): v is string => !!v && v.trim().length > 0);
  if (!status || !keys.length) return false;
  const msg = await prisma.conversationMessage.findFirst({
    where: { OR: [{ gatewayId: { in: keys } }, { wamid: { in: keys } }] },
    select: { id: true, companyId: true, conversationId: true, customerId: true, deliveryStatus: true, wamid: true },
  });
  if (!msg) return false;
  // PUENTE id↔wamid: el evento trae el par (id numérico del gateway + wamid de
  // WhatsApp). Los envíos SMS Tools van encolados (priority=2, sin wamid en la
  // respuesta), así que el wamid se APRENDE aquí — con él las reacciones/citas
  // (target_wamid/quoted_wamid) pueden anclar a los mensajes del bot.
  // El wamid es la llave NO numérica del par (el id del gateway es numérico).
  const learnedWamid = !msg.wamid ? keys.find((k) => !/^\d+$/.test(k)) ?? null : null;
  const current = msg.deliveryStatus ?? "pending";
  const isUpgrade =
    status === "failed"
      ? !["delivered", "read", "failed"].includes(current) // ya llegó o ya avisado
      : (DELIVERY_RANK[status] ?? 0) > (DELIVERY_RANK[current] ?? -1); // no degradar ni repetir
  if (!isUpgrade && !learnedWamid) return false;
  await prisma.conversationMessage.update({
    where: { id: msg.id },
    data: {
      ...(isUpgrade ? { deliveryStatus: status } : {}),
      ...(learnedWamid ? { wamid: learnedWamid } : {}),
    },
  });
  if (!isUpgrade) return false;
  socketService.emitToCompany(msg.companyId, SOCKET_EVENTS.MESSAGE_UPDATED, {
    conversationId: msg.conversationId,
    customerId: msg.customerId,
    id: msg.id,
    deliveryStatus: status,
  });
  return true;
}

/** Ancla una reacción emoji al mensaje target (por wamid); vacío la quita. */
export async function applyReaction(companyId: string, targetWamid: string, emoji: string): Promise<boolean> {
  const msg = await prisma.conversationMessage.findFirst({
    where: { companyId, OR: [{ wamid: targetWamid }, { gatewayId: targetWamid }] },
    select: { id: true, conversationId: true, customerId: true },
  });
  if (!msg) return false;
  await prisma.conversationMessage.update({
    where: { id: msg.id },
    data: { reaction: emoji.trim() || null },
  });
  socketService.emitToCompany(companyId, SOCKET_EVENTS.MESSAGE_UPDATED, {
    conversationId: msg.conversationId,
    customerId: msg.customerId,
    id: msg.id,
    reaction: emoji.trim() || null,
  });
  return true;
}

/** Preview del mensaje citado (por wamid, misma empresa) para burbuja y contexto del agente. */
export async function resolveQuotedPreview(companyId: string, quotedWamid: string): Promise<string | null> {
  const quoted = await prisma.conversationMessage.findFirst({
    where: { companyId, OR: [{ wamid: quotedWamid }, { gatewayId: quotedWamid }] },
    select: { message: true, mediaType: true },
  });
  if (!quoted) return null;
  const text = (quoted.message ?? "").replace(/\s+/g, " ").trim();
  if (text) return text.slice(0, 160);
  return quoted.mediaType ? `[${quoted.mediaType}]` : null;
}

/**
 * Actualiza el texto de un mensaje ya registrado (sin reemitir socket). Lo usa el
 * análisis de imagen para anotar en el mensaje del cliente QUÉ muestra la imagen,
 * de modo que buildHistory se lo pase al agente (que es texto-only).
 */
export async function annotateMessageText(messageId: string, text: string): Promise<void> {
  await prisma.conversationMessage
    .update({ where: { id: messageId }, data: { message: text } })
    .catch(() => undefined);
}

// -------------------------------------------------------------------------
// Lecturas para el panel admin (visor de conversaciones en tiempo real)
// -------------------------------------------------------------------------
export async function listConversations(companyId: string, limit = 50) {
  const rows = await prisma.conversation.findMany({
    // whatsapp + web (chat embebido); excluye la conversación del simulador (canal "sim")
    where: { companyId, channel: { in: ["whatsapp", "web"] } },
    orderBy: { lastMessageAt: "desc" },
    take: limit,
    select: {
      id: true,
      status: true,
      botPaused: true,
      state: true,
      channel: true,
      lastMessageAt: true,
      openedAt: true,
      customer: {
        select: {
          id: true,
          phone: true,
          name: true,
          avatarUrl: true,
          waUsername: true,
          adSourceId: true,
          adTitle: true,
          tagLinks: { select: { tag: { select: { id: true, name: true, color: true } } } },
        },
      },
      messages: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { message: true, role: true, createdAt: true },
      },
    },
  });
  const adMap = await resolveAdDescriptions(companyId);
  return rows.map((c) => ({
    id: c.id,
    status: c.status,
    botPaused: c.botPaused,
    channel: c.channel,
    // Etapa del embudo (state.status). Distinto de `status` (OPEN/HUMAN/CLOSED).
    funnelStatus: ((c.state as ConversationState) ?? {}).status ?? null,
    humanReason: humanReasonOf(c.state as ConversationState, c.botPaused),
    lastMessageAt: c.lastMessageAt,
    openedAt: c.openedAt,
    customer: serializeCustomerWithTags(c.customer, adMap),
    lastMessage: c.messages[0] ?? null,
  }));
}

/**
 * Motivo de la derivación a humano (si el bot está pausado por derivar_humano):
 * state.pendingAction guarda "HUMAN[MOTIVO]: razón" — se normaliza para el panel.
 */
export function humanReasonOf(state: ConversationState | null | undefined, botPaused: boolean): string | null {
  if (!botPaused) return null;
  const pending = state?.pendingAction;
  if (typeof pending !== "string" || !pending.startsWith("HUMAN")) return null;
  const reason = pending.replace(/^HUMAN(\[[A-Z]+\])?:\s*/, "").trim();
  return reason || null;
}

/** Aplana tagLinks → tags y resuelve el anuncio de origen (atribución CTWA). */
function serializeCustomerWithTags(
  customer: {
    id: string;
    phone: string;
    name: string | null;
    avatarUrl?: string | null;
    waUsername?: string | null;
    adSourceId?: string | null;
    adTitle?: string | null;
    tagLinks: Array<{ tag: { id: string; name: string; color: string } }>;
  },
  adMap?: Map<string, string>,
) {
  const { tagLinks, adSourceId, adTitle, ...rest } = customer;
  return {
    ...rest,
    tags: tagLinks.map((l) => l.tag),
    ad: adInfoFor(adMap ?? new Map(), adSourceId, adTitle),
  };
}

/**
 * Resumen de UNA conversación, con el mismo shape que un item de listConversations.
 * Para el panel: al abrir un chat enlazado (p.ej. desde el CRM) que no está entre
 * los últimos 50 de la lista, el front lo resuelve por id sin paginar.
 */
export async function getConversationSummary(companyId: string, conversationId: string) {
  const c = await prisma.conversation.findFirst({
    where: { id: conversationId, companyId, channel: { in: ["whatsapp", "web"] } },
    select: {
      id: true,
      status: true,
      botPaused: true,
      state: true,
      channel: true,
      lastMessageAt: true,
      openedAt: true,
      customer: {
        select: {
          id: true,
          phone: true,
          name: true,
          avatarUrl: true,
          waUsername: true,
          adSourceId: true,
          adTitle: true,
          tagLinks: { select: { tag: { select: { id: true, name: true, color: true } } } },
        },
      },
      messages: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { message: true, role: true, createdAt: true },
      },
    },
  });
  if (!c) return null;
  return {
    id: c.id,
    status: c.status,
    botPaused: c.botPaused,
    channel: c.channel,
    funnelStatus: ((c.state as ConversationState) ?? {}).status ?? null,
    humanReason: humanReasonOf(c.state as ConversationState, c.botPaused),
    lastMessageAt: c.lastMessageAt,
    openedAt: c.openedAt,
    customer: serializeCustomerWithTags(c.customer, await resolveAdDescriptions(companyId)),
    lastMessage: c.messages[0] ?? null,
  };
}

/**
 * Estado runtime fresco de una conversación (para el turno debounced del agente,
 * que corre desfasado del inbound y debe leer el estado más reciente).
 */
export async function getConversationRuntime(
  conversationId: string,
): Promise<{ state: ConversationState; botPaused: boolean; channel: string } | null> {
  const c = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { state: true, botPaused: true, channel: true },
  });
  if (!c) return null;
  return { state: (c.state as ConversationState) ?? {}, botPaused: c.botPaused, channel: c.channel };
}

/** customerId de una conversación (para reset/cancelar recordatorios desde el panel). */
export async function getConversationCustomerId(
  companyId: string,
  conversationId: string,
): Promise<string | null> {
  const convo = await prisma.conversation.findFirst({
    where: { id: conversationId, companyId },
    select: { customerId: true },
  });
  return convo?.customerId ?? null;
}

/** Envía un mensaje manual (humano/asesor) al cliente por su canal y lo registra. */
/**
 * wamid utilizable de un mensaje para reaccionar/citar: la columna wamid, o el
 * gatewayId cuando ya ES un wamid (Meta guarda el wamid ahí; el id numérico de
 * SMS Tools no sirve — el wamid real se aprende del webhook de estados).
 */
function whatsappIdOf(row: { wamid: string | null; gatewayId: string | null }): string | null {
  if (row.wamid) return row.wamid;
  return row.gatewayId && !/^\d+$/.test(row.gatewayId) ? row.gatewayId : null;
}

export async function sendHumanReply(
  companyId: string,
  conversationId: string,
  message: string,
  opts?: { quoteMessageId?: string | null },
) {
  const convo = await prisma.conversation.findFirst({
    where: { id: conversationId, companyId },
    select: { id: true, channel: true, customerId: true, customer: { select: { phone: true } } },
  });
  if (!convo) throw new AppError("Conversación no encontrada", 404);

  // Canal web: el mensaje viaja por socket al widget del visitante, no por WhatsApp.
  const sender = convo.channel === "web" ? webSender(convo.id) : await loadWhatsappSender(companyId);
  if (!sender) throw new AppError("No hay una cuenta de WhatsApp activa para enviar", 422);

  // Responder CITANDO: resolver el wamid del mensaje citado (misma conversación)
  // y quién lo escribió ("" = cliente, "me" = propio) + preview para la burbuja.
  let quote: { wamid: string; from: "" | "me"; preview: string | null } | null = null;
  if (opts?.quoteMessageId) {
    const quoted = await prisma.conversationMessage.findFirst({
      where: { id: opts.quoteMessageId, companyId, conversationId },
      select: { wamid: true, gatewayId: true, role: true, message: true, mediaType: true },
    });
    if (!quoted) throw new AppError("El mensaje a citar no existe en esta conversación", 404);
    const wamid = whatsappIdOf(quoted);
    if (!wamid) {
      throw new AppError(
        "Aún no tengo el ID de WhatsApp de ese mensaje (llega con el ✓✓). Intenta en unos segundos.",
        409,
      );
    }
    const previewText = (quoted.message ?? "").replace(/\s+/g, " ").trim();
    quote = {
      wamid,
      from: quoted.role === "USER" ? "" : "me",
      preview: previewText ? previewText.slice(0, 160) : quoted.mediaType ? `[${quoted.mediaType}]` : null,
    };
  }

  const to = convo.customer.phone.replace(/\D/g, "");
  const text = (await applyFirma(companyId, message)) ?? message;
  const sent = await sendText(sender, to, text, quote ? { quoteWamid: quote.wamid, quoteFrom: quote.from } : undefined);
  await recordMessage({
    companyId,
    customerId: convo.customerId,
    conversationId,
    role: "ADMIN",
    message: text,
    // Los mensajes del asesor también ganan checks y son anclables (wamid se
    // aprende del webhook de estados vía el gatewayId).
    gatewayId: sent.gatewayId,
    deliveryStatus: sent.gatewayId ? "pending" : null,
    quotedWamid: quote?.wamid ?? null,
    quotedPreview: quote?.preview ?? null,
  });
}

/**
 * Reacciona (o quita la reacción, emoji "") a un mensaje del chat desde el
 * panel. El target se ancla por su wamid (USER: llega en el inbound; bot/asesor:
 * se aprende del webhook de estados — si aún no llegó, error legible).
 */
export async function reactToMessage(
  companyId: string,
  conversationId: string,
  messageId: string,
  emoji: string,
): Promise<void> {
  const convo = await prisma.conversation.findFirst({
    where: { id: conversationId, companyId },
    select: { id: true, channel: true, customerId: true, customer: { select: { phone: true } } },
  });
  if (!convo) throw new AppError("Conversación no encontrada", 404);
  if (convo.channel === "web") throw new AppError("Las reacciones no están disponibles en el chat web", 422);

  const msg = await prisma.conversationMessage.findFirst({
    where: { id: messageId, companyId, conversationId },
    select: { id: true, role: true, wamid: true, gatewayId: true },
  });
  if (!msg) throw new AppError("Mensaje no encontrado", 404);
  const targetWamid = whatsappIdOf(msg);
  if (!targetWamid) {
    throw new AppError(
      "Aún no tengo el ID de WhatsApp de ese mensaje (llega con el ✓✓). Intenta en unos segundos.",
      409,
    );
  }

  const sender = await loadWhatsappSender(companyId);
  if (!sender) throw new AppError("No hay una cuenta de WhatsApp activa para enviar", 422);

  await sendReaction(sender, convo.customer.phone.replace(/\D/g, ""), {
    wamid: targetWamid,
    emoji: emoji.trim(),
    fromMe: msg.role !== "USER",
  });

  await prisma.conversationMessage.update({
    where: { id: msg.id },
    data: { ownReaction: emoji.trim() || null },
  });
  socketService.emitToCompany(companyId, SOCKET_EVENTS.MESSAGE_UPDATED, {
    conversationId,
    customerId: convo.customerId,
    id: msg.id,
    ownReaction: emoji.trim() || null,
  });
}

/**
 * Programa un recordatorio MANUAL desde el panel de Conversaciones (atención
 * humana). Se marca metadata.manual=true para que el worker lo envíe aunque la
 * conversación esté en atención humana (botPaused) — a diferencia de los
 * recordatorios del agente, que se cancelan al pausar. Respeta el horario hábil.
 */
export async function scheduleManualReminder(
  companyId: string,
  conversationId: string,
  opts: { message: string; sendAt: Date; mediaUrl?: string | null; mediaType?: string | null },
) {
  const convo = await prisma.conversation.findFirst({
    where: { id: conversationId, companyId },
    select: { customerId: true, company: { select: { timezone: true } } },
  });
  if (!convo) throw new AppError("Conversación no encontrada", 404);
  const body = (opts.message ?? "").trim();
  if (!body && !opts.mediaUrl) throw new AppError("El recordatorio necesita un mensaje", 400);
  if (!(opts.sendAt instanceof Date) || isNaN(opts.sendAt.getTime()) || opts.sendAt.getTime() <= Date.now()) {
    throw new AppError("La fecha del recordatorio debe ser futura", 400);
  }

  const followup = await prisma.agentConfig.findUnique({
    where: { companyId },
    select: { followupConfig: true },
  });

  await scheduleReminder({
    companyId,
    customerId: convo.customerId,
    conversationId,
    type: ScheduledMessageType.CUSTOM,
    sendAt: opts.sendAt,
    body,
    mediaUrl: opts.mediaUrl ?? null,
    metadata: {
      manual: true,
      ...(opts.mediaType ? { mediaType: opts.mediaType } : {}),
    },
    timezone: convo.company?.timezone ?? "America/Lima",
    quietHours: (followup?.followupConfig as { quietHours?: unknown } | null)?.quietHours,
  });
}

/**
 * Envío manual de multimedia por el operador humano (botón adjuntar del panel).
 * El caption (si trae texto) se firma igual que el resto de salidas.
 */
export async function sendHumanMedia(
  companyId: string,
  conversationId: string,
  media: { mediaUrl: string; mediaKind: "image" | "video" | "audio" | "document"; caption?: string; fileName?: string },
) {
  const convo = await prisma.conversation.findFirst({
    where: { id: conversationId, companyId },
    select: { id: true, channel: true, customerId: true, customer: { select: { phone: true } } },
  });
  if (!convo) throw new AppError("Conversación no encontrada", 404);

  const sender = convo.channel === "web" ? webSender(convo.id) : await loadWhatsappSender(companyId);
  if (!sender) throw new AppError("No hay una cuenta de WhatsApp activa para enviar", 422);

  const to = convo.customer.phone.replace(/\D/g, "");
  const caption = (await applyFirma(companyId, media.caption)) ?? media.caption;
  await sendMedia(sender, to, media.mediaKind, media.mediaUrl, caption, media.fileName);
  await recordMessage({
    companyId,
    customerId: convo.customerId,
    conversationId,
    role: "ADMIN",
    message: caption ?? null,
    mediaUrl: media.mediaUrl,
    mediaType: media.mediaKind,
  });
}

/**
 * Inicia una conversación saliente desde el panel (botón "Nueva conversación"):
 * crea o reutiliza el chat del número indicado, envía el primer mensaje como asesor
 * humano y lo deja visible en Conversaciones. Útil cuando el mensaje del cliente no
 * llegó al sistema (p. ej. durante un despliegue). NO pausa el bot: si el cliente
 * responde, el agente puede continuar.
 */
export async function startConversation(
  companyId: string,
  phone: string,
  message: string,
): Promise<{ conversationId: string }> {
  const normalized = normalizePhone(phone);
  if (normalized.replace(/\D/g, "").length < 8) {
    throw new AppError("Número de teléfono inválido", 400);
  }
  const text = message.trim();
  if (!text) throw new AppError("El mensaje no puede estar vacío", 400);

  const sender = await loadWhatsappSender(companyId);
  if (!sender) throw new AppError("No hay una cuenta de WhatsApp activa para enviar", 422);

  const convo = await loadOrCreateConversation(companyId, normalized, null);

  const finalText = (await applyFirma(companyId, text)) ?? text;
  await sendText(sender, normalized.replace(/\D/g, ""), finalText);
  await recordMessage({
    companyId,
    customerId: convo.customerId,
    conversationId: convo.conversationId,
    role: "ADMIN",
    message: finalText,
  });
  // Subir al tope de la lista + refrescar el panel en tiempo real.
  await prisma.conversation.update({
    where: { id: convo.conversationId },
    data: { lastMessageAt: new Date() },
  });
  socketService.emitToCompany(companyId, SOCKET_EVENTS.CONVERSATION_UPDATED, {
    conversationId: convo.conversationId,
  });
  return { conversationId: convo.conversationId };
}

/**
 * Elimina un chat = elimina el LEAD/cliente por completo (historial, estado, y su
 * presencia en TODOS los CRM). Unifica el borrado: lo que se borra en Conversaciones
 * también desaparece del CRM y viceversa. Bloquea solo si el cliente tiene una venta
 * aprobada (comprobante APROBADO). Delega en deleteCustomer (cascade + eventos).
 */
export async function deleteConversation(companyId: string, conversationId: string): Promise<void> {
  const convo = await prisma.conversation.findFirst({
    where: { id: conversationId, companyId },
    select: { id: true, customerId: true },
  });
  if (!convo) throw new AppError("Conversación no encontrada", 404);
  await deleteCustomer(companyId, convo.customerId);
}

/**
 * Elimina en lote varias conversaciones (selección masiva del panel). Aplica los
 * mismos guards por chat que deleteConversation: las que tienen pago asociado o
 * están esperando pago se omiten (no se borran) y se reportan con su motivo.
 */
export async function deleteConversations(
  companyId: string,
  ids: string[],
): Promise<{ deleted: string[]; skipped: Array<{ id: string; reason: string }> }> {
  const clean = [...new Set(ids.map((s) => String(s).trim()).filter(Boolean))];
  const deleted: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const id of clean) {
    try {
      await deleteConversation(companyId, id);
      deleted.push(id);
    } catch (err) {
      const reason = err instanceof AppError ? err.message : "No se pudo eliminar";
      skipped.push({ id, reason });
    }
  }
  return { deleted, skipped };
}

/**
 * Reinicia el contexto de una conversación (para pruebas / comando "reset" del
 * cliente): borra historial, carrito y estado; reactiva el bot.
 */
export async function resetConversation(
  companyId: string,
  conversationId: string,
  customerId: string,
): Promise<void> {
  await prisma.conversationMessage.deleteMany({ where: { companyId, conversationId } });
  await prisma.cart.deleteMany({ where: { companyId, customerId } });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { state: {}, status: "OPEN", botPaused: false, lastInboundId: null },
  });
  socketService.emitToCompany(companyId, SOCKET_EVENTS.CONVERSATION_UPDATED, {
    conversationId,
    reset: true,
  });
}

/** Resuelve una conversación (whatsapp) por el teléfono del cliente. */
export async function findConversationByCustomerPhone(companyId: string, phone: string) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8) return null;
  let cust = await prisma.customer.findFirst({
    where: { companyId, phone: `+${digits}` },
    select: { id: true, phone: true },
  });
  if (!cust) {
    cust = await prisma.customer.findFirst({
      where: { companyId, phone: { contains: digits.slice(-9) } },
      select: { id: true, phone: true },
    });
  }
  if (!cust) return null;
  const convo = await prisma.conversation.findFirst({
    where: { companyId, customerId: cust.id, channel: "whatsapp" },
    select: { id: true, botPaused: true, status: true },
  });
  return convo
    ? { id: convo.id, botPaused: convo.botPaused, status: convo.status, customerPhone: cust.phone }
    : null;
}

/** Teléfono del cliente de una conversación. */
export async function getConversationCustomerPhone(
  companyId: string,
  conversationId: string,
): Promise<string | null> {
  const convo = await prisma.conversation.findFirst({
    where: { id: conversationId, companyId },
    select: { customer: { select: { phone: true } } },
  });
  return convo?.customer.phone ?? null;
}

/** Envía un aviso al WhatsApp del dueño (número de notificación de pago). */
export async function notifyOwner(companyId: string, message: string): Promise<void> {
  const pay = await prisma.paymentConfig.findUnique({
    where: { companyId },
    select: { notificationPhone: true },
  });
  const ownerPhone = (pay?.notificationPhone ?? "").replace(/\D/g, "");
  if (!ownerPhone) return;
  const sender = await loadWhatsappSender(companyId);
  if (!sender) return;
  try {
    await sendText(sender, ownerPhone, message);
  } catch {
    /* best-effort */
  }
}

export async function listConversationMessages(
  companyId: string,
  conversationId: string,
  limit = 200,
) {
  const rows = await prisma.conversationMessage.findMany({
    where: { companyId, conversationId },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
      id: true,
      role: true,
      message: true,
      mediaUrl: true,
      mediaType: true,
      createdAt: true,
      // Checks de entrega, reacción anclada y preview de la cita (panel).
      deliveryStatus: true,
      reaction: true,
      quotedPreview: true,
      // wamid (normalizado abajo): el panel decide si un mensaje ya es
      // reaccionable/citable; ownReaction: la reacción del asesor.
      wamid: true,
      gatewayId: true,
      ownReaction: true,
    },
  });
  return rows.map(({ gatewayId, ...r }) => ({ ...r, wamid: whatsappIdOf({ wamid: r.wamid, gatewayId }) }));
}

/**
 * Construye el historial (ultimos N turnos) en formato OpenAI. Incluye los
 * mensajes del ASESOR HUMANO (rol ADMIN), mapeados como "assistant", para que el
 * bot tenga continuidad de lo que se conversó durante el control humano.
 */
/** Prefijo que marca, en el historial, los mensajes que escribió un asesor humano
 *  del equipo (rol ADMIN: take-over manual o respuestas rápidas). El system prompt
 *  explica este marcador para que el modelo no los confunda con sus propios mensajes. */
export const HUMAN_AGENT_TAG = "「Asesor humano del equipo」";

export async function buildHistory(conversationId: string): Promise<ChatMessage[]> {
  const limit = env.AGENT_HISTORY_LIMIT;
  const rows = await prisma.conversationMessage.findMany({
    where: { conversationId, role: { in: ["USER", "ASSISTANT", "ADMIN"] } },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { role: true, message: true, mediaUrl: true, mediaType: true, quotedPreview: true },
  });
  rows.reverse();
  return rows.map((r) => {
    // USER = cliente. ADMIN (asesor humano/respuesta rápida) y ASSISTANT (el bot y los
    // recordatorios) son el lado del negocio = assistant; al ADMIN le anteponemos un
    // marcador para que el modelo sepa que lo escribió un humano, no él.
    const isUser = r.role === "USER";
    const isHuman = r.role === "ADMIN";
    const role: "user" | "assistant" = isUser ? "user" : "assistant";

    let content = (r.message ?? "").trim();
    if (!content && r.mediaUrl) {
      const isAudio = (r.mediaType ?? "").toLowerCase() === "audio";
      content = isUser
        ? isAudio
          ? "[el cliente envió un audio que no se pudo transcribir: pídele amablemente que lo repita por texto]"
          : "[el cliente envió una imagen]"
        : "[se envió una imagen/archivo al cliente]";
    }
    if (isHuman) content = `${HUMAN_AGENT_TAG} ${content}`;
    // Respuesta citando: el agente recibe QUÉ citó el cliente (el panel pinta su
    // propio bloque de cita — este prefijo es solo para el contexto del modelo).
    if (isUser && r.quotedPreview) content = `[Responde citando: "${r.quotedPreview}"] ${content}`;
    return { role, content };
  });
}
