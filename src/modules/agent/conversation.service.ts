/**
 * Persistencia de conversaciones del agente.
 *
 * Reemplaza el `staticData.customers` de n8n: cada cliente (por telefono) tiene
 * un Customer + una Conversation con `state` (JSON) y un historial real de
 * ConversationMessage que se le pasa a OpenAI cada turno.
 */

import { Prisma, ConversationRole } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { AppError } from "../../lib/app-error";
import { socketService, SOCKET_EVENTS } from "../../lib/socket";
import { loadWhatsappSender, sendText } from "./outbound";
import type { ChatMessage } from "../../lib/openai";

/** Estado conversacional persistido en Conversation.state (equivalente al customer.* de n8n). */
export interface ConversationState {
  status?: string;            // NUEVO, INTERESADO, ESPERANDO_PAGO, ENTREGADO, etc.
  selectedProductId?: string | null;
  lastPaymentPromptAt?: string | null;
  pendingAction?: string | null;
  offerExpiresAt?: string | null;
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
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { botPaused: paused, status: paused ? "HUMAN" : "OPEN" },
  });
  socketService.emitToCompany(companyId, SOCKET_EVENTS.CONVERSATION_UPDATED, {
    conversationId,
    botPaused: paused,
  });
}

/** Persiste un mensaje y emite el evento de tiempo real al panel. */
export async function recordMessage(opts: {
  companyId: string;
  customerId: string;
  conversationId: string;
  role: ConversationRole;
  message?: string | null;
  mediaUrl?: string | null;
  productId?: string | null;
  rawPayload?: Prisma.InputJsonValue;
}): Promise<void> {
  const created = await prisma.conversationMessage.create({
    data: {
      companyId: opts.companyId,
      customerId: opts.customerId,
      conversationId: opts.conversationId,
      role: opts.role,
      message: opts.message ?? null,
      mediaUrl: opts.mediaUrl ?? null,
      productId: opts.productId ?? null,
      ...(opts.rawPayload !== undefined ? { rawPayload: opts.rawPayload } : {}),
    },
    select: { id: true, role: true, message: true, mediaUrl: true, createdAt: true },
  });
  socketService.emitToCompany(opts.companyId, SOCKET_EVENTS.MESSAGE_NEW, {
    conversationId: opts.conversationId,
    customerId: opts.customerId,
    id: created.id,
    role: created.role,
    message: created.message,
    mediaUrl: created.mediaUrl,
    createdAt: created.createdAt,
  });
}

// -------------------------------------------------------------------------
// Lecturas para el panel admin (visor de conversaciones en tiempo real)
// -------------------------------------------------------------------------
export async function listConversations(companyId: string, limit = 50) {
  const rows = await prisma.conversation.findMany({
    where: { companyId },
    orderBy: { lastMessageAt: "desc" },
    take: limit,
    select: {
      id: true,
      status: true,
      botPaused: true,
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
    lastMessageAt: c.lastMessageAt,
    customer: c.customer,
    lastMessage: c.messages[0] ?? null,
  }));
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
  await sendText(sender, to, message);
  await recordMessage({
    companyId,
    customerId: convo.customerId,
    conversationId,
    role: "ADMIN",
    message,
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
    select: { id: true, role: true, message: true, mediaUrl: true, createdAt: true },
  });
}

/** Construye el historial (ultimos N turnos) en formato OpenAI. */
export async function buildHistory(conversationId: string): Promise<ChatMessage[]> {
  const limit = env.AGENT_HISTORY_LIMIT;
  const rows = await prisma.conversationMessage.findMany({
    where: { conversationId, role: { in: ["USER", "ASSISTANT"] } },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { role: true, message: true, mediaUrl: true },
  });
  rows.reverse();
  return rows.map((r) => {
    const role: "user" | "assistant" = r.role === "ASSISTANT" ? "assistant" : "user";
    let content = r.message ?? "";
    if (!content && r.mediaUrl) content = "[el cliente envió un archivo adjunto]";
    return { role, content };
  });
}
