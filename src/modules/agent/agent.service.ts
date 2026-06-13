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
import { readReceiptImage } from "./receipt-vision";
import { runAgentTurn } from "./agent-runtime";
import { deliver, flushOutbox, sleep, OUTBOX_GAP_MS } from "./delivery";
import { runFlowTurn, buildRealFlowIO, trailingUserText } from "../flows/flow-engine";
import { tryApprovePayment, type TurnContext } from "./agent-tools";
import { summarizeCart } from "./cart.service";
import { resolveCompanyIdByPhone } from "../public-payments/public-payments.service";
import {
  scheduleReminder,
  cancelPendingReminders,
  schedulePaymentRecheck,
  minutesFromNow,
  secondsFromNow,
} from "../scheduler/scheduler.service";
import { resolveReminderSequence, type ReminderType } from "./reminder-templates";

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

  // Números en atención humana forzada (lista del panel): el bot NUNCA les
  // responde (ni al comando reset). El mensaje se persiste para que se vea en
  // Conversaciones y la conversación pasa a HUMANO automáticamente.
  const muted = ((config as any).agent?.mutedNumbers ?? []) as string[];
  if (muted.length > 0 && isPhoneAllowed(inbound.fromPhone, muted)) {
    await recordMessage({
      companyId,
      customerId: convo.customerId,
      conversationId: convo.conversationId,
      role: "USER",
      message: inbound.text || null,
      mediaUrl: inbound.mediaUrl,
      mediaType: inbound.mediaUrl && inbound.type !== "text" ? inbound.type : null,
      rawPayload: inbound.raw as any,
    });
    await markInboundProcessed(convo.conversationId, inbound.messageId);
    if (!convo.botPaused) {
      await setBotPaused(companyId, convo.conversationId, true);
    }
    console.log(`[agent] ${inbound.fromPhone} en lista de atención humana: sin respuesta del bot`);
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
    mediaType: inbound.mediaUrl && inbound.type !== "text" ? inbound.type : null,
    rawPayload: inbound.raw as any,
  });
  await markInboundProcessed(convo.conversationId, inbound.messageId);

  // Comprobante de pago (imagen) en contexto de pago: leerlo con visión (monto,
  // hora, código) y reenviárselo al admin como aviso, SIN pausar el bot. El bot
  // sigue su flujo normal (pedirá el código/nombre del titular).
  if (inbound.mediaUrl && inbound.type === "image" && isPaymentContext(convo.state)) {
    await handleReceiptImage(companyId, config, convo, inbound);
  }

  // El cliente respondió => cancelar follow-ups de silencio/abandono pendientes.
  // En modo FLOW también los timeouts de bloque y los recordatorios del flujo
  // (CUSTOM): si el cliente vuelve a escribir, el flujo decide de nuevo.
  await cancelPendingReminders(companyId, convo.customerId, [
    ScheduledMessageType.LEFT_ON_READ,
    ScheduledMessageType.ABANDONED_CART,
    ...((config as any).business?.botMode === "FLOW"
      ? [ScheduledMessageType.FLOW_TIMEOUT, ScheduledMessageType.CUSTOM]
      : []),
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

  // Modo FLOW: corre el motor de flujos guiados en lugar del agente IA. El motor
  // envía todo por su propio IO (deliver) y deja el estado en ctx.state.
  if (config.business.botMode === "FLOW") {
    try {
      await runFlowTurn(buildRealFlowIO(ctx, sender), trailingUserText(history), history);
    } catch (err) {
      console.error("[flows] runFlowTurn falló:", err instanceof Error ? err.message : err);
    }
    await saveState(conversationId, ctx.state);
    return;
  }

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

  // Recordatorios solicitados por el modelo (clampeados a horario hábil)
  for (const r of ctx.reminders) {
    await scheduleReminder({
      companyId,
      customerId,
      conversationId,
      type: toReminderType(r.type),
      sendAt: minutesFromNow(r.minutes),
      body: r.body,
      timezone: config.business.timezone,
      quietHours: (config.agent.followupConfig as { quietHours?: unknown } | null)?.quietHours,
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
 * Reintento de validación de pago (lo dispara el worker del scheduler al vencer
 * un PAYMENT_RECHECK, ~1 min después de que el cliente dijo que pagó). Si el
 * comprobante ya entró, aprueba y ENTREGA automáticamente; si no, deriva a un
 * asesor humano (pausa el bot, avisa al admin con la imagen) y tranquiliza al
 * cliente. Best-effort: nunca lanza.
 */
export async function recheckPayment(msg: {
  companyId: string;
  customerId: string;
  conversationId: string | null;
  metadata: unknown;
}): Promise<void> {
  try {
    if (!msg.conversationId) return;
    const conversationId = msg.conversationId;
    const md = (msg.metadata ?? {}) as {
      payerName?: string | null;
      expectedAmount?: number | null;
      operationCode?: string | null;
      customerPhone?: string;
      receiptMediaUrl?: string | null;
    };

    // Idempotencia: si el propio turno del cliente ya aprobó/entregó, o ya está
    // en manos de un humano, no hacer nada.
    const runtime = await getConversationRuntime(conversationId);
    if (!runtime) return;
    const state = runtime.state ?? {};
    const status = (state.status as string) ?? "";
    if (status === "PAGADO" || status === "ENTREGADO" || runtime.botPaused) return;

    let config: Awaited<ReturnType<typeof buildBotConfig>>;
    try {
      config = await buildBotConfig(msg.companyId);
    } catch {
      return;
    }
    const sender = await loadWhatsappSender(msg.companyId);
    if (!sender) return;
    const to = (md.customerPhone ?? "").replace(/\D/g, "");

    // Códigos: del estado (lo que leyó la visión) + lo que vino en la metadata.
    const codes = [
      state.lastReceipt?.operationNumber,
      state.lastReceipt?.securityCode,
      md.operationCode,
    ]
      .map((c) => (c ?? "").trim())
      .filter(Boolean) as string[];

    const result = await tryApprovePayment({
      companyId: msg.companyId,
      customerId: msg.customerId,
      conversationId,
      customerPhone: md.customerPhone ?? to,
      config,
      state,
      payerName: md.payerName ?? undefined,
      codes,
      expected: md.expectedAmount ?? undefined,
      deliver: true,
    });

    if (result.approved && result.deliveryOutbox?.length) {
      if (result.customerMessage && to) {
        try {
          await sendText(sender, to, result.customerMessage);
        } catch {
          /* best-effort */
        }
      }
      await flushOutbox(sender, to, result.deliveryOutbox, {
        companyId: msg.companyId,
        customerId: msg.customerId,
        conversationId,
      });
      await saveState(conversationId, state as ConversationState);
      console.log(`[agent] recheckPayment: aprobado y entregado (conv=${conversationId})`);
      return;
    }
    if (result.approved) {
      // Aprobado pero sin entrega digital (no digital): solo persistir estado.
      await saveState(conversationId, state as ConversationState);
      return;
    }

    // Sin match tras 1 min → derivar a un asesor humano y tranquilizar al cliente.
    await setBotPaused(msg.companyId, conversationId, true);
    state.pendingRecheckAt = null;
    await saveState(conversationId, state as ConversationState);
    if (to) {
      try {
        await sendText(
          sender,
          to,
          "Estoy verificando tu pago con un asesor para confirmarlo cuanto antes 🙏 En breve te confirmamos, ¡gracias por tu paciencia!",
        );
      } catch {
        /* best-effort */
      }
    }
    const adminPhone = (config.payment.notification?.whatsappPhone || config.business.adminPhone || "").replace(/\D/g, "");
    if (adminPhone) {
      const caption =
        `🔔 Pago por validar de ${md.customerPhone ?? to}. No se encontró el comprobante automáticamente tras 1 min. ` +
        `Revísalo y confírmalo desde Comprobantes/Conversaciones. El bot quedó en atención humana para este cliente.`;
      try {
        if (md.receiptMediaUrl) await sendMedia(sender, adminPhone, "image", md.receiptMediaUrl, caption);
        else await sendText(sender, adminPhone, caption);
      } catch {
        /* best-effort */
      }
    }
    console.log(`[agent] recheckPayment: sin match → derivado a humano (conv=${conversationId})`);
  } catch (err) {
    console.warn("[agent] recheckPayment falló:", err instanceof Error ? err.message : err);
  }
}

/** ¿La conversación está esperando/validando un pago? (contexto para leer comprobantes). */
function isPaymentContext(state: ConversationState): boolean {
  if (state.lastPaymentPromptAt) return true;
  const s = state.status ?? "";
  return s === "ESPERANDO_PAGO" || s === "ESPERANDO_VALIDACION";
}

/**
 * Comprobante (imagen) recibido en contexto de pago. Hace TODO de forma
 * determinista (no depende del modelo): lo lee con visión (monto, hora, N° de
 * operación, código), se lo reenvía al admin como aviso (sin pausar), e INTENTA
 * validar+entregar al instante usando el N° de operación. Si no puede aún
 * (timing), tranquiliza y agenda el reintento; si falta dato, lo pide. El turno
 * del modelo ve `receiptAutoHandledAt` y no vuelve a tocar el pago.
 */
async function handleReceiptImage(
  companyId: string,
  config: Awaited<ReturnType<typeof buildBotConfig>>,
  convo: { conversationId: string; customerId: string; state: ConversationState },
  inbound: InboundMessage,
): Promise<void> {
  const imageUrl = inbound.mediaUrl;
  const fromPhone = inbound.fromPhone;
  if (!imageUrl || !fromPhone) return;
  const sender = await loadWhatsappSender(companyId);
  if (!sender) return;
  const to = fromPhone.replace(/\D/g, "");

  // 1) Visión (best-effort; requiere la API key del tenant).
  const apiKey = (config as { openai?: { apiKey?: string | null } }).openai?.apiKey ?? null;
  const model = (config as { openai?: { model?: string } }).openai?.model || "gpt-4o-mini";
  let receipt: Awaited<ReturnType<typeof readReceiptImage>> = null;
  if (apiKey) {
    receipt = await readReceiptImage(apiKey, model, imageUrl);
    if (receipt) {
      convo.state.lastReceipt = {
        amountText: receipt.amountText,
        time: receipt.time,
        operationNumber: receipt.operationNumber,
        securityCode: receipt.securityCode,
        mediaUrl: imageUrl,
        at: new Date().toISOString(),
      };
      await saveState(convo.conversationId, convo.state);
    }
  }

  // 2) Reenviar el comprobante al admin (solo aviso; NO pausa el bot).
  const adminPhone = (config.payment.notification?.whatsappPhone || config.business.adminPhone || "").replace(/\D/g, "");
  if (adminPhone) {
    const name = await getCustomerName(convo.customerId);
    const datos = receipt
      ? `Monto: ${receipt.amountText ?? "—"}` +
        (receipt.operationNumber ? ` · op: ${receipt.operationNumber}` : "") +
        (receipt.securityCode ? ` · código: ${receipt.securityCode}` : "")
      : "No se pudo leer la imagen automáticamente.";
    const caption = `🧾 Comprobante recibido${name ? ` de ${name}` : ""} (${fromPhone}).\n${datos}`;
    try {
      await sendMedia(sender, adminPhone, "image", imageUrl, caption);
    } catch {
      /* best-effort */
    }
  }

  // 3) Auto-validación determinista (N° de operación como llave).
  const codes = [receipt?.operationNumber, receipt?.securityCode]
    .map((c) => (c ?? "").trim())
    .filter(Boolean) as string[];
  if (!codes.length) return; // sin código legible: lo maneja el turno del modelo

  const result = await tryApprovePayment({
    companyId,
    customerId: convo.customerId,
    conversationId: convo.conversationId,
    customerPhone: fromPhone,
    config,
    state: convo.state,
    codes,
    deliver: true,
  });
  convo.state.receiptAutoHandledAt = new Date().toISOString();

  try {
    if (result.approved && result.deliveryOutbox?.length) {
      if (result.customerMessage && to) await sendText(sender, to, result.customerMessage);
      await flushOutbox(sender, to, result.deliveryOutbox, {
        companyId,
        customerId: convo.customerId,
        conversationId: convo.conversationId,
      });
    } else if (!result.approved && result.shouldRecheck) {
      if (result.customerMessage && to) await sendText(sender, to, result.customerMessage);
      await schedulePaymentRecheck({
        companyId,
        customerId: convo.customerId,
        conversationId: convo.conversationId,
        sendAt: new Date(Date.now() + 60 * 1000),
        expectedAmount: undefined,
        operationCode: codes[0],
        customerPhone: fromPhone,
        receiptMediaUrl: imageUrl,
      });
      convo.state.pendingRecheckAt = new Date().toISOString();
    } else if (!result.approved && result.customerMessage && to) {
      // confusión / falta dato / monto distinto
      await sendText(sender, to, result.customerMessage);
    }
  } catch (err) {
    console.warn("[agent] auto-validación de comprobante falló:", err instanceof Error ? err.message : err);
  }
  await saveState(convo.conversationId, convo.state);
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

  // Programa TODA la secuencia (varios mensajes) de un tipo: un ScheduledMessage por
  // step, cada uno con su delay (absoluto desde ahora) y su contenido.
  const scheduleSeq = async (type: ReminderType, smType: ScheduledMessageType) => {
    const seq = resolveReminderSequence(followup, type, productReminder, vars);
    if (!seq.enabled) return;
    for (const step of seq.steps) {
      await scheduleReminder({
        companyId,
        customerId,
        conversationId,
        type: smType,
        sendAt: secondsFromNow(step.delaySeconds),
        body: step.message,
        mediaUrl: step.mediaUrl,
        metadata: step.mediaType ? { mediaType: step.mediaType } : undefined,
        timezone: config.business.timezone,
        quietHours: (followup as { quietHours?: unknown } | null)?.quietHours,
      });
    }
  };

  const status = state.status ?? "";

  // Estados terminales/humano/entregado: no programar seguimiento (el post-venta lo
  // cubren los mensajes adicionales tras la entrega del Paso 5).
  if (["ENTREGADO", "PEDIDO_REGISTRADO", "RESERVA_SOLICITADA", "ASESOR_HUMANO"].includes(status)) return;

  // Abandono de carrito: esperando pago con carrito/producto.
  if (status === "ESPERANDO_PAGO" && (cart.items.length || state.selectedProductId)) {
    await scheduleSeq("abandonedCart", ScheduledMessageType.ABANDONED_CART);
  }

  // Dejado en visto: el cliente escribió y el bot respondió; si no contesta, seguimos.
  await scheduleSeq("leftOnRead", ScheduledMessageType.LEFT_ON_READ);
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
