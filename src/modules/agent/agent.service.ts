/**
 * Orquestación del agente: punto de entrada del webhook inbound de WhatsApp.
 *
 * Resuelve el tenant por la cuenta SMS Tools que recibió el mensaje, carga la
 * conversación, corre el turno del agente y envía las respuestas por WhatsApp.
 * Reemplaza por completo el workflow de n8n.
 */

import { ScheduledMessageType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { buildBotConfig } from "../bot/bot.service";
import type { InboundMessage } from "../../lib/smstools-client";
import {
  loadOrCreateConversation,
  markInboundProcessed,
  recordMessage,
  buildHistory,
  saveState,
  setBotPaused,
  type ConversationState,
} from "./conversation.service";
import { loadWhatsappSender, sendText, sendMedia, type WhatsappSender } from "./outbound";
import { runAgentTurn } from "./agent-runtime";
import type { TurnContext, OutboxMessage } from "./agent-tools";
import { summarizeCart } from "./cart.service";
import { resolveCompanyIdByPhone } from "../public-payments/public-payments.service";
import { scheduleReminder, cancelPendingReminders, minutesFromNow } from "../scheduler/scheduler.service";

interface FollowupConfig {
  abandonedCartHours?: number;
  leftOnReadMinutes?: number;
}

async function resolveCompanyByAccount(account: string | null): Promise<string | null> {
  if (!account) return null;
  const cfg = await prisma.whatsappConfig.findFirst({
    where: { account, isActive: true },
    select: { companyId: true, company: { select: { isActive: true } } },
  });
  if (!cfg || !cfg.company.isActive) return null;
  return cfg.companyId;
}

/**
 * Resuelve el tenant del mensaje entrante. Prioridad:
 *  1) account SMS Tools si vino en el payload (raro en inbound),
 *  2) businessPhone (numero propio del negocio = data[wid]) contra el phone del
 *     admin, igual que hacía bot/config en n8n.
 */
async function resolveCompany(inbound: InboundMessage): Promise<string | null> {
  const byAccount = await resolveCompanyByAccount(inbound.account);
  if (byAccount) return byAccount;
  if (inbound.businessPhone) {
    try {
      return await resolveCompanyIdByPhone(inbound.businessPhone);
    } catch {
      return null;
    }
  }
  return null;
}

/** Procesa un mensaje entrante. Pensado para correr en background (no bloquea el webhook). */
export async function handleInbound(inbound: InboundMessage): Promise<void> {
  if (inbound.fromMe) {
    return; // eco de un mensaje saliente del propio negocio
  }
  if (!inbound.fromPhone) {
    console.warn("[agent] inbound sin fromPhone, ignorado");
    return;
  }
  // El cliente no puede ser el mismo numero del negocio (evita loops por eco)
  if (inbound.businessPhone && inbound.fromPhone === inbound.businessPhone) {
    return;
  }

  const companyId = await resolveCompany(inbound);
  if (!companyId) {
    console.warn(
      `[agent] no se resolvió empresa (account=${inbound.account ?? "-"}, business=${inbound.businessPhone ?? "-"})`,
    );
    return;
  }

  let config;
  try {
    config = await buildBotConfig(companyId, inbound.account ?? undefined);
  } catch (err) {
    console.error("[agent] buildBotConfig falló:", err instanceof Error ? err.message : err);
    return; // sin config (p.ej. falta openaiApiKey) no podemos responder
  }

  const convo = await loadOrCreateConversation(companyId, inbound.fromPhone, inbound.messageId);

  // Idempotencia: si ya procesamos este messageId, no repetir
  if (inbound.messageId && convo.lastInboundId === inbound.messageId) {
    return;
  }

  // Persistir el mensaje del cliente
  await recordMessage({
    companyId,
    customerId: convo.customerId,
    conversationId: convo.conversationId,
    role: "USER",
    message: inbound.text || null,
    mediaUrl: inbound.mediaUrl,
    rawPayload: inbound.raw as any,
  });
  await markInboundProcessed(convo.conversationId, inbound.messageId);

  // El cliente respondió => cancelar follow-ups de silencio/abandono pendientes
  await cancelPendingReminders(companyId, convo.customerId, [
    ScheduledMessageType.LEFT_ON_READ,
    ScheduledMessageType.ABANDONED_CART,
  ]);

  // Si la conversación está en manos de un humano, el bot no responde
  if (convo.botPaused) {
    return;
  }

  const sender = await loadWhatsappSender(companyId);
  if (!sender) {
    console.warn(`[agent] empresa ${companyId} sin WhatsappConfig activa con account`);
    return;
  }

  const history = await buildHistory(convo.conversationId);

  const ctx: TurnContext = {
    companyId,
    customerId: convo.customerId,
    conversationId: convo.conversationId,
    customerPhone: inbound.fromPhone,
    config,
    state: convo.state,
    outbox: [],
    reminders: [],
  };

  let finalText: string;
  try {
    finalText = await runAgentTurn(ctx, history);
  } catch (err) {
    console.error("[agent] runAgentTurn falló:", err instanceof Error ? err.message : err);
    finalText = "Disculpa, estoy teniendo un inconveniente. En un momento te atiendo.";
  }

  // Enviar adjuntos/mensajes acumulados por las herramientas, en orden
  await flushOutbox(sender, inbound.fromPhone, ctx.outbox, ctx);

  // Enviar y registrar el texto final
  if (finalText) {
    await deliver(sender, inbound.fromPhone, { kind: "text", text: finalText }, ctx);
  }

  await saveState(convo.conversationId, ctx.state);

  // Recordatorios solicitados por el modelo
  for (const r of ctx.reminders) {
    await scheduleReminder({
      companyId,
      customerId: convo.customerId,
      conversationId: convo.conversationId,
      type: toReminderType(r.type),
      sendAt: minutesFromNow(r.minutes),
      body: r.body,
    });
  }

  // Red de seguridad: si quedó esperando pago con carrito, programar abandono
  await maybeScheduleAbandonedCart(companyId, convo.customerId, convo.conversationId, ctx.state, config);

  // Derivación a humano
  if (ctx.state.status === "ASESOR_HUMANO") {
    await setBotPaused(companyId, convo.conversationId, true);
    await notifyAdmin(sender, config, inbound.fromPhone, ctx.state.pendingAction);
  }
}

async function flushOutbox(
  sender: WhatsappSender,
  to: string,
  outbox: OutboxMessage[],
  ctx: TurnContext,
): Promise<void> {
  for (const msg of outbox) {
    await deliver(sender, to, msg, ctx);
  }
}

async function deliver(
  sender: WhatsappSender,
  to: string,
  msg: OutboxMessage,
  ctx: TurnContext,
): Promise<void> {
  try {
    if (msg.kind === "media" && msg.mediaUrl) {
      await sendMedia(sender, to, msg.mediaKind ?? "image", msg.mediaUrl, msg.caption);
      await recordMessage({
        companyId: ctx.companyId,
        customerId: ctx.customerId,
        conversationId: ctx.conversationId,
        role: "ASSISTANT",
        message: msg.caption ?? null,
        mediaUrl: msg.mediaUrl,
      });
    } else if (msg.text) {
      await sendText(sender, to, msg.text);
      await recordMessage({
        companyId: ctx.companyId,
        customerId: ctx.customerId,
        conversationId: ctx.conversationId,
        role: "ASSISTANT",
        message: msg.text,
      });
    }
  } catch (err) {
    console.error("[agent] error enviando WhatsApp:", err instanceof Error ? err.message : err);
  }
}

function toReminderType(value: string): ScheduledMessageType {
  const v = value.toUpperCase();
  if (v in ScheduledMessageType) return ScheduledMessageType[v as keyof typeof ScheduledMessageType];
  return ScheduledMessageType.CUSTOM;
}

async function maybeScheduleAbandonedCart(
  companyId: string,
  customerId: string,
  conversationId: string,
  state: ConversationState,
  config: Awaited<ReturnType<typeof buildBotConfig>>,
): Promise<void> {
  if (state.status !== "ESPERANDO_PAGO") return;
  const cart = await summarizeCart(companyId, customerId);
  if (!cart.items.length && !state.selectedProductId) return;

  const followup = (config as any).agent?.followupConfig as FollowupConfig | undefined;
  const hours = followup?.abandonedCartHours ?? 6;

  await scheduleReminder({
    companyId,
    customerId,
    conversationId,
    type: ScheduledMessageType.ABANDONED_CART,
    sendAt: minutesFromNow(hours * 60),
    body:
      `Hola 👋 vi que quedó pendiente tu compra${cart.totalText && cart.items.length ? ` por ${cart.totalText}` : ""}. ` +
      `¿Te ayudo a completarla? Sigue disponible 🙌`,
  });
}

async function notifyAdmin(
  sender: WhatsappSender,
  config: Awaited<ReturnType<typeof buildBotConfig>>,
  customerPhone: string,
  reason: unknown,
): Promise<void> {
  const adminPhone = config.payment.notification?.whatsappPhone || config.business.adminPhone;
  if (!adminPhone) return;
  const to = adminPhone.replace(/\D/g, "");
  try {
    await sendText(
      sender,
      to,
      `🔔 Un cliente (${customerPhone}) necesita atención humana.\nMotivo: ${String(reason ?? "—")}`,
    );
  } catch {
    /* best-effort */
  }
}
