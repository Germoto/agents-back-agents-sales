/**
 * Persistencia de conversaciones del agente.
 *
 * Reemplaza el `staticData.customers` de n8n: cada cliente (por telefono) tiene
 * un Customer + una Conversation con `state` (JSON) y un historial real de
 * ConversationMessage que se le pasa a OpenAI cada turno.
 */

import { Prisma, ConversationRole, ScheduledMessageType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { cancelPendingReminders } from "../scheduler/scheduler.service";
import { env } from "../../config/env";
import { AppError } from "../../lib/app-error";
import { socketService, SOCKET_EVENTS } from "../../lib/socket";
import { loadWhatsappSender, sendText, sendMedia } from "./outbound";
import { applyFirma } from "./firma";
import type { ChatMessage } from "../../lib/openai";

/** Estado conversacional persistido en Conversation.state (equivalente al customer.* de n8n). */
export interface ConversationState {
  status?: string;            // NUEVO, INTERESADO, ESPERANDO_PAGO, ENTREGADO, etc.
  selectedProductId?: string | null;
  lastPaymentPromptAt?: string | null;
  pendingAction?: string | null;
  offerExpiresAt?: string | null;
  /** Productos cuya ficha ya se envió en esta conversación (evita reenviarla). */
  presentedProductIds?: string[];
  /** Productos cuya multimedia ya se envió en esta conversación. */
  mediaSentProductIds?: string[];
  /** Producto relacionado (cross-sell) ofrecido tras la última entrega; da contexto al agente. */
  offeredCrossSellProductId?: string | null;
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
  [key: string]: unknown;
}

export interface LoadedConversation {
  customerId: string;
  conversationId: string;
  state: ConversationState;
  botPaused: boolean;
  lastInboundId: string | null;
}

function normalizePhone(value: string) {
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
) {
  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: { botPaused: paused, status: paused ? "HUMAN" : "OPEN" },
    select: { customerId: true },
  });
  socketService.emitToCompany(companyId, SOCKET_EVENTS.CONVERSATION_UPDATED, {
    conversationId,
    botPaused: paused,
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
}): Promise<void> {
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
      ...(opts.rawPayload !== undefined ? { rawPayload: opts.rawPayload } : {}),
    },
    select: { id: true, role: true, message: true, mediaUrl: true, mediaType: true, createdAt: true },
  });
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
}

// -------------------------------------------------------------------------
// Lecturas para el panel admin (visor de conversaciones en tiempo real)
// -------------------------------------------------------------------------
export async function listConversations(companyId: string, limit = 50) {
  const rows = await prisma.conversation.findMany({
    where: { companyId, channel: "whatsapp" }, // excluye la conversación del simulador (canal "sim")
    orderBy: { lastMessageAt: "desc" },
    take: limit,
    select: {
      id: true,
      status: true,
      botPaused: true,
      state: true,
      lastMessageAt: true,
      customer: { select: { id: true, phone: true, name: true } },
      messages: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { message: true, role: true, createdAt: true },
      },
    },
  });
  return rows.map((c) => ({
    id: c.id,
    status: c.status,
    botPaused: c.botPaused,
    // Etapa del embudo (state.status). Distinto de `status` (OPEN/HUMAN/CLOSED).
    funnelStatus: ((c.state as ConversationState) ?? {}).status ?? null,
    lastMessageAt: c.lastMessageAt,
    customer: c.customer,
    lastMessage: c.messages[0] ?? null,
  }));
}

/**
 * Estado runtime fresco de una conversación (para el turno debounced del agente,
 * que corre desfasado del inbound y debe leer el estado más reciente).
 */
export async function getConversationRuntime(
  conversationId: string,
): Promise<{ state: ConversationState; botPaused: boolean } | null> {
  const c = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { state: true, botPaused: true },
  });
  if (!c) return null;
  return { state: (c.state as ConversationState) ?? {}, botPaused: c.botPaused };
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

/** Envía un mensaje manual (humano/asesor) al cliente por WhatsApp y lo registra. */
export async function sendHumanReply(companyId: string, conversationId: string, message: string) {
  const convo = await prisma.conversation.findFirst({
    where: { id: conversationId, companyId },
    select: { id: true, customerId: true, customer: { select: { phone: true } } },
  });
  if (!convo) throw new AppError("Conversación no encontrada", 404);

  const sender = await loadWhatsappSender(companyId);
  if (!sender) throw new AppError("No hay una cuenta de WhatsApp activa para enviar", 422);

  const to = convo.customer.phone.replace(/\D/g, "");
  const text = (await applyFirma(companyId, message)) ?? message;
  await sendText(sender, to, text);
  await recordMessage({
    companyId,
    customerId: convo.customerId,
    conversationId,
    role: "ADMIN",
    message: text,
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
    select: { id: true, customerId: true, customer: { select: { phone: true } } },
  });
  if (!convo) throw new AppError("Conversación no encontrada", 404);

  const sender = await loadWhatsappSender(companyId);
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
 * Elimina una conversación completa (historial + estado). Solo permitido cuando
 * el cliente no tiene un pago asociado activo ni está esperando pago.
 */
export async function deleteConversation(companyId: string, conversationId: string): Promise<void> {
  const convo = await prisma.conversation.findFirst({
    where: { id: conversationId, companyId },
    select: { id: true, customerId: true, state: true },
  });
  if (!convo) throw new AppError("Conversación no encontrada", 404);

  // Guard 1: no eliminar si hay comprobantes en proceso/aprobados del cliente.
  const receiptCount = await prisma.paymentReceipt.count({
    where: {
      companyId,
      customerId: convo.customerId,
      status: { in: ["PENDIENTE", "EN_REVISION", "APROBADO"] },
    },
  });
  if (receiptCount > 0) {
    throw new AppError("No puedes eliminar este chat: tiene un pago asociado.", 409);
  }

  // Guard 2: no eliminar si está esperando pago/validación.
  const status = ((convo.state as ConversationState) ?? {}).status ?? null;
  if (status === "ESPERANDO_PAGO" || status === "ESPERANDO_VALIDACION") {
    throw new AppError("No puedes eliminar este chat: está esperando un pago.", 409);
  }

  // ConversationMessage.conversationId es SetNull: borrar mensajes explícitamente
  // para no dejar huérfanos.
  await prisma.$transaction([
    prisma.conversationMessage.deleteMany({ where: { companyId, conversationId } }),
    prisma.conversation.delete({ where: { id: conversationId } }),
  ]);
  socketService.emitToCompany(companyId, SOCKET_EVENTS.CONVERSATION_UPDATED, {
    conversationId,
    deleted: true,
  });
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
  return prisma.conversationMessage.findMany({
    where: { companyId, conversationId },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, role: true, message: true, mediaUrl: true, mediaType: true, createdAt: true },
  });
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
    select: { role: true, message: true, mediaUrl: true },
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
      content = isUser
        ? "[el cliente envió una imagen/archivo (posible comprobante de pago)]"
        : "[se envió una imagen/archivo al cliente]";
    }
    if (isHuman) content = `${HUMAN_AGENT_TAG} ${content}`;
    return { role, content };
  });
}
