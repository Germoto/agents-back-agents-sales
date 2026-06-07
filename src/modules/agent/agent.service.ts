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
  sendHumanReply,
  findConversationByCustomerPhone,
  type ConversationState,
} from "./conversation.service";
import { loadWhatsappSender, sendText, sendMedia, type WhatsappSender } from "./outbound";
import { runAgentTurn } from "./agent-runtime";
import type { TurnContext, OutboxMessage } from "./agent-tools";
import { summarizeCart } from "./cart.service";
import { resolveCompanyIdByPhone } from "../public-payments/public-payments.service";
import { scheduleReminder, cancelPendingReminders, minutesFromNow } from "../scheduler/scheduler.service";
import { resolveReminderTemplate, type ReminderType } from "./reminder-templates";

interface FollowupConfig {
  abandonedCartHours?: number;
  leftOnReadMinutes?: number;
}

/** Match tolerante por sufijo de dígitos (cubre con/sin código de país). */
function isPhoneAllowed(fromPhone: string, allow: string[]): boolean {
  const a = fromPhone.replace(/\D/g, "");
  if (!a) return false;
  for (const raw of allow) {
    const b = String(raw).replace(/\D/g, "");
    if (!b) continue;
    if (a === b || a.endsWith(b) || b.endsWith(a)) {
      // evita falsos positivos por sufijos muy cortos
      if (Math.min(a.length, b.length) >= 8) return true;
    }
  }
  return false;
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

  // Comandos del dueño (canal de control = número de notificación de pago). Si el
  // mensaje viene de ese número y es un comando, se procesa y NO se corre el agente.
  const ownerPhone = (config as any).payment?.notification?.whatsappPhone as string | null | undefined;
  if (ownerPhone && isPhoneAllowed(inbound.fromPhone, [ownerPhone])) {
    const handled = await handleOwnerCommand(companyId, config, inbound);
    if (handled) return;
    // Si no era comando, el dueño puede probar el bot como un cliente más (sigue el flujo).
  }

  // Modo de respuesta: en ALLOWLIST (modo prueba) el agente solo responde a los
  // números configurados; a cualquier otro lo ignora por completo.
  const replyMode = (config as any).agent?.replyMode ?? "OPEN";
  if (replyMode === "ALLOWLIST") {
    const allow = ((config as any).agent?.testNumbers ?? []) as string[];
    if (!isPhoneAllowed(inbound.fromPhone, allow)) {
      console.log(`[agent] ignorado por ALLOWLIST: ${inbound.fromPhone}`);
      return;
    }
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
    adminNotices: [],
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

  // Recordatorios automáticos (con plantillas configuradas): abandono de carrito,
  // dejado en visto y post-venta.
  await scheduleAutoReminders(companyId, convo.customerId, convo.conversationId, ctx.state, config);

  // Avisos al admin (pedidos registrados, etc.)
  if (ctx.adminNotices.length) {
    const adminPhone = (config.payment.notification?.whatsappPhone || config.business.adminPhone || "").replace(/\D/g, "");
    if (adminPhone) {
      for (const notice of ctx.adminNotices) {
        try {
          await sendText(sender, adminPhone, notice);
        } catch {
          /* best-effort */
        }
      }
    }
  }

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

async function getCustomerName(customerId: string): Promise<string> {
  const c = await prisma.customer.findUnique({ where: { id: customerId }, select: { name: true } });
  return c?.name ?? "";
}

/**
 * Programa los recordatorios automáticos según el estado, usando las plantillas
 * configuradas (texto + imagen + variables) del negocio y el override por producto.
 */
async function scheduleAutoReminders(
  companyId: string,
  customerId: string,
  conversationId: string,
  state: ConversationState,
  config: Awaited<ReturnType<typeof buildBotConfig>>,
): Promise<void> {
  const cart = await summarizeCart(companyId, customerId);
  const pid = cart.items[0]?.productId ?? state.selectedProductId ?? null;
  const product = pid ? config.products.find((p) => p.id === pid || p.slug === pid) : undefined;
  const vars = {
    nombre: await getCustomerName(customerId),
    producto: product?.name,
    total: cart.items.length ? cart.totalText : undefined,
    negocio: config.business.name,
  };
  const followup = config.agent.followupConfig;
  const productReminder = (product as { reminderConfig?: unknown } | undefined)?.reminderConfig;

  const schedule = async (type: ReminderType, smType: ScheduledMessageType) => {
    const tpl = resolveReminderTemplate(followup, type, productReminder, vars);
    if (!tpl.enabled || !tpl.message) return;
    await scheduleReminder({
      companyId,
      customerId,
      conversationId,
      type: smType,
      sendAt: minutesFromNow(tpl.delayMinutes),
      body: tpl.message,
      mediaUrl: tpl.mediaUrl,
    });
  };

  const status = state.status ?? "";

  // Post-venta: tras entregar / cerrar.
  if (status === "ENTREGADO") {
    await schedule("postSale", ScheduledMessageType.POST_SALE);
    return;
  }

  // Estados terminales/humano: no programar seguimiento de silencio.
  if (["PEDIDO_REGISTRADO", "RESERVA_SOLICITADA", "ASESOR_HUMANO"].includes(status)) return;

  // Abandono de carrito: esperando pago con carrito/producto.
  if (status === "ESPERANDO_PAGO" && (cart.items.length || state.selectedProductId)) {
    await schedule("abandonedCart", ScheduledMessageType.ABANDONED_CART);
  }

  // Dejado en visto: el cliente escribió y el bot respondió; si no contesta, seguimos.
  await schedule("leftOnRead", ScheduledMessageType.LEFT_ON_READ);
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
  const num = customerPhone.replace(/\D/g, "");
  try {
    await sendText(
      sender,
      to,
      `🔔 Un cliente (${customerPhone}) necesita atención humana.\n` +
        `Motivo: ${String(reason ?? "—")}\n\n` +
        `El bot quedó pausado para este cliente. Para atenderlo tú:\n` +
        `• Responder: *${num} tu mensaje*\n` +
        `• Reactivar el bot: *BOT ${num}*\n` +
        `(También puedes atenderlo desde la web, en Conversaciones.)`,
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Procesa un comando del dueño enviado por WhatsApp (canal = número de notificación).
 * Devuelve true si era un comando (y ya se actuó); false si era texto normal.
 * Comandos: HUMANO/PAUSAR/ASESOR <num> [msg], BOT/REANUDAR/ACTIVAR <num>,
 * ESTADO <num>, y relay "<num> mensaje".
 */
async function handleOwnerCommand(
  companyId: string,
  config: Awaited<ReturnType<typeof buildBotConfig>>,
  inbound: InboundMessage,
): Promise<boolean> {
  const text = (inbound.text ?? "").trim();
  if (!text) return false;

  const sender = await loadWhatsappSender(companyId);
  if (!sender) return false;
  const ownerTo = (config.payment.notification?.whatsappPhone ?? "").replace(/\D/g, "");
  const reply = async (msg: string) => {
    try {
      await sendText(sender, ownerTo, msg);
    } catch {
      /* best-effort */
    }
  };

  const m = text.match(/^(HUMANO|PAUSAR|ASESOR|BOT|REANUDAR|ACTIVAR|ESTADO)\s*\+?(\d{8,15})?\s*([\s\S]*)$/i);
  if (m) {
    const cmd = m[1].toUpperCase();
    const num = m[2];
    const rest = (m[3] ?? "").trim();
    if (!num) {
      await reply(`Indica el número del cliente. Ej: *${cmd} 51999888777*`);
      return true;
    }
    const convo = await findConversationByCustomerPhone(companyId, num);
    if (!convo) {
      await reply(`No encontré una conversación con ${num}.`);
      return true;
    }
    if (["HUMANO", "PAUSAR", "ASESOR"].includes(cmd)) {
      await setBotPaused(companyId, convo.id, true);
      if (rest) await sendHumanReply(companyId, convo.id, rest);
      await reply(
        `✅ Tomaste el control de ${num}. El bot quedó pausado.\n` +
          `Respóndele con: *${num} tu mensaje*\nReactivar el bot: *BOT ${num}*`,
      );
      return true;
    }
    if (["BOT", "REANUDAR", "ACTIVAR"].includes(cmd)) {
      await setBotPaused(companyId, convo.id, false);
      await reply(`✅ Bot reactivado para ${num}. El agente vuelve a responder.`);
      return true;
    }
    if (cmd === "ESTADO") {
      await reply(`Estado de ${num}: ${convo.botPaused ? "ATENCIÓN HUMANA (bot pausado)" : "BOT ACTIVO"}.`);
      return true;
    }
  }

  // Relay: "<num> mensaje" → responder al cliente (toma control si hace falta)
  const r = text.match(/^\+?(\d{8,15})\s+([\s\S]+)$/);
  if (r) {
    const num = r[1];
    const msg = r[2].trim();
    const convo = await findConversationByCustomerPhone(companyId, num);
    if (!convo) {
      await reply(`No encontré una conversación con ${num}.`);
      return true;
    }
    if (!convo.botPaused) await setBotPaused(companyId, convo.id, true);
    await sendHumanReply(companyId, convo.id, msg);
    return true;
  }

  // No es un comando: el dueño puede usar el bot como cliente.
  return false;
}
