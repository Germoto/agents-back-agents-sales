/**
 * Canal Web: chat embebible en la web del tenant (widget + iframe).
 *
 * El visitante abre una sesión con el token público de la empresa (validado
 * contra los dominios permitidos), escribe por HTTP y recibe las respuestas del
 * agente por Socket.IO (room `webchat:<conversationId>`). El agente corre con el
 * MISMO runtime que WhatsApp: aquí solo se persiste el inbound y se agenda el
 * turno debounced; el sender WEB (outbound.ts) emite el outbox por socket.
 */

import crypto from "crypto";
import { ScheduledMessageType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { signWebchatToken, type WebchatJwtPayload } from "../../lib/jwt";
import { normalizePhone, recordMessage } from "../agent/conversation.service";
import { scheduleTurn } from "../agent/agent.service";
import { cancelPendingReminders } from "../scheduler/scheduler.service";
import { getEntitlements } from "../billing/entitlements";
import { gateNewLead } from "../billing/billing.service";
import type { CreateSessionInput, UpdateWebchatConfigInput } from "./webchat.schemas";

const HISTORY_LIMIT = 50;

function newWidgetToken(): string {
  return `wc_${crypto.randomBytes(16).toString("hex")}`;
}

/** Phone sintético de visitante anónimo (sin WhatsApp). Prefijo "web:" = guard en scheduler/campañas. */
function syntheticPhone(): string {
  return `web:${crypto.randomBytes(12).toString("hex")}`;
}

/** hostname normalizado de una entrada de dominio o URL ("https://x.com/p" → "x.com"). */
function hostnameOf(value: string): string | null {
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  try {
    const url = raw.includes("://") ? new URL(raw) : new URL(`https://${raw}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** ¿El origin de la página embebedora está permitido? (lista vacía = abierto). */
export function originAllowed(parentOrigin: string | undefined, allowedOrigins: string[]): boolean {
  if (!allowedOrigins.length) return true;
  const host = hostnameOf(parentOrigin ?? "");
  if (!host) return false;
  return allowedOrigins.some((entry) => {
    const allowed = hostnameOf(entry);
    if (!allowed) return false;
    return host === allowed || host.endsWith(`.${allowed}`);
  });
}

// ---------------------------------------------------------------------------
// Config del panel (Chat Web)
// ---------------------------------------------------------------------------

export async function getWebchatConfig(companyId: string) {
  const existing = await prisma.webchatConfig.findUnique({ where: { companyId } });
  const cfg =
    existing ??
    (await prisma.webchatConfig.create({
      data: { companyId, token: newWidgetToken() },
    }));
  return {
    enabled: cfg.enabled,
    token: cfg.token,
    allowedOrigins: cfg.allowedOrigins,
    welcomeMessage: cfg.welcomeMessage,
    accentColor: cfg.accentColor,
  };
}

export async function updateWebchatConfig(companyId: string, data: UpdateWebchatConfigInput) {
  await getWebchatConfig(companyId); // crea la fila (con token) si no existe
  await prisma.webchatConfig.update({
    where: { companyId },
    data: {
      ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      ...(data.allowedOrigins !== undefined ? { allowedOrigins: data.allowedOrigins } : {}),
      ...(data.welcomeMessage !== undefined ? { welcomeMessage: data.welcomeMessage } : {}),
      ...(data.accentColor !== undefined ? { accentColor: data.accentColor } : {}),
    },
  });
  return getWebchatConfig(companyId);
}

/** Regenera el token público: las sesiones activas siguen (JWT), pero el snippet viejo deja de abrir sesiones nuevas. */
export async function regenerateWebchatToken(companyId: string) {
  await getWebchatConfig(companyId);
  await prisma.webchatConfig.update({
    where: { companyId },
    data: { token: newWidgetToken() },
  });
  return getWebchatConfig(companyId);
}

// ---------------------------------------------------------------------------
// Sesión del visitante (público)
// ---------------------------------------------------------------------------

export async function createSession(input: CreateSessionInput) {
  const cfg = await prisma.webchatConfig.findUnique({
    where: { token: input.token },
    select: {
      companyId: true,
      enabled: true,
      allowedOrigins: true,
      welcomeMessage: true,
      accentColor: true,
      company: { select: { name: true } },
    },
  });
  if (!cfg || !cfg.enabled) throw new AppError("Chat no disponible", 404);
  if (!originAllowed(input.parentOrigin, cfg.allowedOrigins)) {
    throw new AppError("Dominio no autorizado para este chat", 403);
  }

  const companyId = cfg.companyId;
  const name = (input.name ?? "").trim() || null;

  // Identidad: con WhatsApp → MISMO Customer que el canal WhatsApp (CRM,
  // campañas y seguimiento unificados); sin WhatsApp → visitante anónimo con
  // phone sintético "web:…".
  const phoneDigits = (input.phone ?? "").replace(/\D/g, "");
  if (input.phone && phoneDigits.length < 8) {
    throw new AppError("El número de WhatsApp no es válido", 400);
  }
  const phone = phoneDigits.length >= 8 ? normalizePhone(phoneDigits) : syntheticPhone();

  // GATE de billing: mismo criterio que el inbound de WhatsApp — solo los
  // números NUEVOS cuentan/descartan como lead.
  const entitlements = await getEntitlements(companyId);
  if (!entitlements.legacy) {
    const existing = await prisma.customer.findUnique({
      where: { companyId_phone: { companyId, phone } },
      select: { id: true },
    });
    if (!existing) {
      const allowed = await gateNewLead(companyId, phone);
      if (!allowed) throw new AppError("Chat no disponible por el momento", 503);
    }
  }

  const customer = await prisma.customer.upsert({
    where: { companyId_phone: { companyId, phone } },
    update: {
      lastInteractionAt: new Date(),
      ...(name ? { name } : {}),
    },
    create: {
      companyId,
      phone,
      name,
      status: "activo",
      lastInteractionAt: new Date(),
      metadata: { origin: "webchat" },
    },
    select: { id: true, name: true },
  });

  const conversation = await prisma.conversation.upsert({
    where: { companyId_customerId_channel: { companyId, customerId: customer.id, channel: "web" } },
    update: { lastMessageAt: new Date() },
    create: { companyId, customerId: customer.id, channel: "web", state: {} },
    select: { id: true },
  });

  const sessionToken = signWebchatToken({
    companyId,
    conversationId: conversation.id,
    customerId: customer.id,
  });

  return {
    sessionToken,
    conversationId: conversation.id,
    companyName: cfg.company.name,
    welcomeMessage: cfg.welcomeMessage,
    accentColor: cfg.accentColor,
    history: await loadHistory(conversation.id),
  };
}

async function loadHistory(conversationId: string) {
  const rows = await prisma.conversationMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
    select: { id: true, role: true, message: true, mediaUrl: true, mediaType: true, createdAt: true },
  });
  return rows.reverse();
}

export async function getSessionHistory(session: WebchatJwtPayload) {
  const convo = await prisma.conversation.findFirst({
    where: { id: session.conversationId, companyId: session.companyId, channel: "web" },
    select: { id: true },
  });
  if (!convo) throw new AppError("Sesión inválida", 401);
  return { history: await loadHistory(convo.id) };
}

export async function postVisitorMessage(session: WebchatJwtPayload, message: string) {
  const convo = await prisma.conversation.findFirst({
    where: { id: session.conversationId, companyId: session.companyId, channel: "web" },
    select: { id: true, customerId: true, botPaused: true, customer: { select: { phone: true } } },
  });
  if (!convo) throw new AppError("Sesión inválida", 401);

  const messageId = await recordMessage({
    companyId: session.companyId,
    customerId: convo.customerId,
    conversationId: convo.id,
    role: "USER",
    message,
  });

  await prisma.customer
    .update({ where: { id: convo.customerId }, data: { lastInteractionAt: new Date() } })
    .catch(() => undefined);

  // El visitante respondió: cancela los follow-ups de silencio/abandono (mismo
  // comportamiento que el inbound de WhatsApp).
  await cancelPendingReminders(session.companyId, convo.customerId, [
    ScheduledMessageType.LEFT_ON_READ,
    ScheduledMessageType.ABANDONED_CART,
  ]).catch(() => undefined);

  // En atención humana el bot no responde: el mensaje queda en el panel.
  if (!convo.botPaused) {
    scheduleTurn({
      companyId: session.companyId,
      conversationId: convo.id,
      customerId: convo.customerId,
      customerPhone: convo.customer.phone,
      account: null,
    });
  }

  return { id: messageId, queued: !convo.botPaused };
}
