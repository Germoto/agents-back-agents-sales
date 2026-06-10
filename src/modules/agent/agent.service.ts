/**
 * Orquestación del agente: punto de entrada del webhook inbound de WhatsApp.
 *
 * Resuelve el tenant por la cuenta SMS Tools que recibió el mensaje, carga la
 * conversación, corre el turno del agente y envía las respuestas por WhatsApp.
 * Reemplaza por completo el workflow de n8n.
 */

import { ScheduledMessageType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
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
  resetConversation,
  getConversationRuntime,
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

/** Comando del cliente para limpiar el contexto y probar de cero (como en n8n). */
function isResetCommand(text: string | null | undefined): boolean {
  const t = (text ?? "").trim().toLowerCase();
  return t === "reset" || t === "/reset" || t === "reiniciar" || t === "reinicia";
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

  // Comando "reset" del cliente: limpia historial/carrito/estado para probar de cero.
  if (isResetCommand(inbound.text)) {
    await markInboundProcessed(convo.conversationId, inbound.messageId);
    await resetConversation(companyId, convo.conversationId, convo.customerId);
    await cancelPendingReminders(companyId, convo.customerId, [
      ScheduledMessageType.ABANDONED_CART,
      ScheduledMessageType.LEFT_ON_READ,
      ScheduledMessageType.OFFER_COUNTDOWN,
      ScheduledMessageType.POST_SALE,
      ScheduledMessageType.CUSTOM,
    ]);
    const sender = await loadWhatsappSender(companyId);
    if (sender) {
      try {
        await sendText(
          sender,
          inbound.fromPhone,
          "♻️ Listo, reinicié nuestra conversación. Empecemos de cero 🙂 ¿En qué te ayudo?",
        );
      } catch {
        /* best-effort */
      }
    }
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

  // No respondemos inline: agendamos el turno con debounce para JUNTAR la ráfaga
  // de mensajes del cliente (escribe en varios mensajes seguidos) y responder UNA
  // sola vez. El mensaje ya quedó persistido arriba, así que cuando el turno corra
  // buildHistory incluirá toda la ráfaga.
  scheduleTurn({
    companyId,
    conversationId: convo.conversationId,
    customerId: convo.customerId,
    customerPhone: inbound.fromPhone,
    account: inbound.account ?? null,
  });
}

// -------------------------------------------------------------------------
// Debounce + serialización por conversación
// -------------------------------------------------------------------------
// Cada inbound persiste su mensaje al instante (idempotencia incluida) y agenda
// un turno. El turno se dispara `AGENT_DEBOUNCE_MS` después del ÚLTIMO mensaje
// (el temporizador se reinicia con cada mensaje nuevo). Además, solo corre UN
// turno por conversación a la vez: si llega un mensaje mientras se está
// respondiendo, se marca `dirty` y se re-agenda al terminar. Así una ráfaga de N
// mensajes produce 1 respuesta (a lo sumo 2 si algo entra durante el turno).
//
// Nota: el estado vive en memoria (single-instance). Si el proceso se reinicia
// dentro de la ventana, el último turno podría quedar sin responder; como los
// mensajes están persistidos, el siguiente inbound del cliente lo re-dispara con
// el historial completo. Para multi-instancia habría que mover el lock a Postgres.

interface TurnJob {
  companyId: string;
  conversationId: string;
  customerId: string;
  customerPhone: string;
  account: string | null;
}

interface PendingTurn {
  timer: NodeJS.Timeout | null;
  running: boolean;
  dirty: boolean;
  job: TurnJob;
}

const pendingTurns = new Map<string, PendingTurn>();

function scheduleTurn(job: TurnJob): void {
  const key = job.conversationId;
  let p = pendingTurns.get(key);
  if (!p) {
    p = { timer: null, running: false, dirty: false, job };
    pendingTurns.set(key, p);
  } else {
    p.job = job; // refresca los datos del último mensaje
  }

  // Si ya hay un turno corriendo, no rearmamos el timer ahora: marcamos que llegó
  // algo nuevo y al terminar el turno se re-agenda.
  if (p.running) {
    p.dirty = true;
    return;
  }

  if (p.timer) clearTimeout(p.timer);
  p.timer = setTimeout(() => {
    void fireTurn(key);
  }, env.AGENT_DEBOUNCE_MS);
}

async function fireTurn(key: string): Promise<void> {
  const p = pendingTurns.get(key);
  if (!p) return;
  p.timer = null;
  p.running = true;
  p.dirty = false;

  try {
    await processConversationTurn(p.job);
  } catch (err) {
    console.error("[agent] processConversationTurn falló:", err instanceof Error ? err.message : err);
  } finally {
    p.running = false;
    // ¿Llegaron mensajes mientras respondíamos? Re-agendamos otra ventana.
    if (p.dirty) {
      p.dirty = false;
      p.timer = setTimeout(() => {
        void fireTurn(key);
      }, env.AGENT_DEBOUNCE_MS);
    } else {
      pendingTurns.delete(key);
    }
  }
}

/**
 * Corre un turno del agente para una conversación. Recarga config y estado
 * frescos (el turno está desfasado del inbound) y responde una sola vez con todo
 * el historial acumulado.
 */
async function processConversationTurn(job: TurnJob): Promise<void> {
  const { companyId, conversationId, customerId, customerPhone, account } = job;

  // Estado fresco: pudo haber cambiado (p.ej. el dueño pausó el bot entre medio).
  const runtime = await getConversationRuntime(conversationId);
  if (!runtime) return;
  if (runtime.botPaused) return;

  let config;
  try {
    config = await buildBotConfig(companyId, account ?? undefined);
  } catch (err) {
    console.error("[agent] buildBotConfig (turno) falló:", err instanceof Error ? err.message : err);
    return;
  }

  const sender = await loadWhatsappSender(companyId);
  if (!sender) {
    console.warn(`[agent] empresa ${companyId} sin WhatsappConfig activa con account`);
    return;
  }

  const history = await buildHistory(conversationId);

  const ctx: TurnContext = {
    companyId,
    customerId,
    conversationId,
    customerPhone,
    config,
    state: runtime.state,
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
  await flushOutbox(sender, customerPhone, ctx.outbox, ctx);

  // Enviar y registrar el texto final (tras una pausa si ya se envió algo, para
  // que llegue DESPUÉS de la multimedia).
  if (finalText) {
    if (ctx.outbox.length) await sleep(OUTBOX_GAP_MS);
    await deliver(sender, customerPhone, { kind: "text", text: finalText }, ctx);
  }

  await saveState(conversationId, ctx.state);

  // Recordatorios solicitados por el modelo
  for (const r of ctx.reminders) {
    await scheduleReminder({
      companyId,
      customerId,
      conversationId,
      type: toReminderType(r.type),
      sendAt: minutesFromNow(r.minutes),
      body: r.body,
    });
  }

  // Recordatorios automáticos (con plantillas configuradas): abandono de carrito,
  // dejado en visto y post-venta.
  await scheduleAutoReminders(companyId, customerId, conversationId, ctx.state, config);

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
    await setBotPaused(companyId, conversationId, true);
    await notifyAdmin(sender, config, customerPhone, ctx.state.pendingAction);
  }
}

// Pausa entre envíos para preservar el ORDEN en WhatsApp (sin esto, mensajes y
// adjuntos enviados muy rápido pueden reordenarse o limitarse por rate).
const OUTBOX_GAP_MS = 900;
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function flushOutbox(
  sender: WhatsappSender,
  to: string,
  outbox: OutboxMessage[],
  ctx: TurnContext,
): Promise<void> {
  for (let i = 0; i < outbox.length; i++) {
    await deliver(sender, to, outbox[i], ctx);
    if (i < outbox.length - 1) await sleep(OUTBOX_GAP_MS);
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
      const r = await sendMedia(sender, to, msg.mediaKind ?? "image", msg.mediaUrl, msg.caption);
      await recordMessage({
        companyId: ctx.companyId,
        customerId: ctx.customerId,
        conversationId: ctx.conversationId,
        role: "ASSISTANT",
        message: msg.caption ?? null,
        mediaUrl: msg.mediaUrl,
        gatewayId: r.gatewayId,
        deliveryStatus: r.gatewayId ? "pending" : null,
      });
    } else if (msg.text) {
      const r = await sendText(sender, to, msg.text);
      await recordMessage({
        companyId: ctx.companyId,
        customerId: ctx.customerId,
        conversationId: ctx.conversationId,
        role: "ASSISTANT",
        message: msg.text,
        gatewayId: r.gatewayId,
        deliveryStatus: r.gatewayId ? "pending" : null,
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
