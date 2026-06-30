/**
 * Orquestación del agente: punto de entrada del webhook inbound de WhatsApp.
 *
 * Resuelve el tenant por la cuenta SMS Tools que recibió el mensaje, carga la
 * conversación, corre el turno del agente y envía las respuestas por WhatsApp.
 * Reemplaza por completo el workflow de n8n.
 */

import { Prisma, ScheduledMessageType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { buildBotConfig } from "../bot/bot.service";
import type { InboundMessage } from "../../lib/smstools-client";
import { persistInboundMedia } from "../../lib/inbound-media";
import {
  loadOrCreateConversation,
  markInboundProcessed,
  recordMessage,
  annotateMessageText,
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
import { tryApprovePayment, muteCustomerToHuman, autoSaleNotice, type TurnContext } from "./agent-tools";
import { summarizeCart } from "./cart.service";
import { resolveCompanyIdByPhone } from "../public-payments/public-payments.service";
import { getLinkedPhone } from "../whatsapp-config/whatsapp-config.service";
import {
  scheduleReminder,
  cancelPendingReminders,
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
 * Igualdad de teléfono SEGURA para verificar la sesión (anti-colisión).
 * A diferencia de `isPhoneAllowed`/`phoneMatches` (sufijo laxo), solo acepta:
 *  - igualdad exacta normalizada, o
 *  - un hueco de código de país (1..3 dígitos) sobre un núcleo largo (>=9),
 *    ej. `51928818265` vs `928818265`. Así evitamos que un wid ajeno con sufijo
 *    parecido se cuele.
 */
function sessionPhoneEquals(a: string, b: string): boolean {
  const da = a.replace(/\D/g, "");
  const db = b.replace(/\D/g, "");
  if (!da || !db) return false;
  if (da === db) return true;
  const [short, long] = da.length <= db.length ? [da, db] : [db, da];
  const gap = long.length - short.length;
  if (gap >= 1 && gap <= 3 && short.length >= 9 && long.endsWith(short)) return true;
  return false;
}

// Cache del teléfono de la cuenta vinculada (getLinkedPhone llama a SMS Tools).
// Evita una llamada de red por cada inbound; se refresca cada SESSION_PHONE_TTL_MS
// y conserva el último valor conocido si SMS Tools falla (no descartar todo en outage).
const SESSION_PHONE_TTL_MS = 10 * 60 * 1000;
const sessionPhoneCache = new Map<string, { digits: string; ts: number }>();

/** Dígitos del teléfono de la sesión (cuenta vinculada), igual que filtra WA API. */
async function getSessionPhoneDigits(companyId: string): Promise<string | null> {
  const cached = sessionPhoneCache.get(companyId);
  if (cached && Date.now() - cached.ts < SESSION_PHONE_TTL_MS) return cached.digits;
  let phone: string | null = null;
  try {
    phone = await getLinkedPhone(companyId);
  } catch {
    phone = null;
  }
  if (phone) {
    const digits = phone.replace(/\D/g, "");
    if (digits) {
      sessionPhoneCache.set(companyId, { digits, ts: Date.now() });
      return digits;
    }
  }
  // Sin valor nuevo (outage o sin cuenta vinculada): usar el último conocido.
  return cached?.digits ?? null;
}

/**
 * Verifica que el inbound pertenezca a la SESIÓN (cuenta de WhatsApp vinculada)
 * de la empresa ya resuelta. Filtra TAL CUAL las pestañas de WhatsApp API: la
 * fuente de verdad es la cuenta vinculada (WhatsappConfig.account → getLinkedPhone),
 * NO el User.phone del admin. Así, si la empresa tiene varios números vinculados,
 * solo entra el de la sesión configurada; los demás se descartan.
 *  (a) si vino `account` → debe coincidir EXACTO con WhatsappConfig.account;
 *  (b) si no, el número receptor (wid) debe ser el de la cuenta vinculada;
 *  (c) sin cuenta vinculada conocida → fallback a User.phone (no descartar todo);
 *  (d) sin account ni wid → no verificable → descartar (fail-closed).
 */
async function verifyInboundSession(companyId: string, inbound: InboundMessage): Promise<boolean> {
  if (inbound.account) {
    const cfg = await prisma.whatsappConfig.findFirst({
      where: { companyId, isActive: true },
      select: { account: true },
    });
    return !!cfg?.account && cfg.account === inbound.account;
  }
  if (inbound.businessPhone) {
    const businessPhone = inbound.businessPhone;
    const sessionDigits = await getSessionPhoneDigits(companyId);
    if (sessionDigits) return sessionPhoneEquals(sessionDigits, businessPhone);
    // Fallback: sin cuenta vinculada conocida (o SMS Tools caído) → User.phone.
    const users = await prisma.user.findMany({
      where: { companyId, isActive: true },
      select: { phone: true },
    });
    return users.some((u) => sessionPhoneEquals(u.phone, businessPhone));
  }
  return false;
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

  // GATE de sesión: solo procesamos mensajes que llegaron al PROPIO número de la
  // empresa (su sesión de WhatsApp). Mensajes de otro número se descartan ANTES de
  // persistir: no se guardan, no crean conversación y no se ven en Conversaciones.
  const belongs = await verifyInboundSession(companyId, inbound);
  if (!belongs) {
    const sessionDigits = await getSessionPhoneDigits(companyId).catch(() => null);
    console.warn(
      `[agent] DROP inbound: no pertenece a la sesión de la empresa ` +
        `(company=${companyId} session=${sessionDigits ?? "-"} account=${inbound.account ?? "-"} ` +
        `business=${inbound.businessPhone ?? "-"} from=${inbound.fromPhone ?? "-"} ` +
        `msgId=${inbound.messageId ?? "-"})`,
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

  // Copiar la media entrante a /uploads (las URLs de SMS Tools expiran y no
  // renderizan en el navegador). Así se ve en el chat y en la lupa de comprobantes,
  // y queda persistida. Best-effort: si falla, se conserva la URL original.
  if (inbound.mediaUrl && inbound.type !== "text") {
    const local = await persistInboundMedia(companyId, inbound.mediaUrl, inbound.type);
    if (local) inbound.mediaUrl = local;
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
  const userMessageId = await recordMessage({
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

  // Comprobante de pago (imagen): si el negocio cobra, cualquier adjunto entrante
  // se LEE con visión (side-channel) y se guarda en state.lastReceipt, y se reenvía
  // al admin como aviso. NO responde al cliente: el AGENTE es la única voz y validará
  // el pago en su turno (con los datos leídos) llamando a validar_pago/entregar_producto.
  const paymentsEnabled = !!(config as any).payment?.enabled;
  console.log(
    `[agent] inbound de ${inbound.fromPhone}: type=${inbound.type} media=${inbound.mediaUrl ? "yes" : "no"} textLen=${(inbound.text ?? "").trim().length} pay=${paymentsEnabled} payCtx=${isPaymentContext(convo.state)}`,
  );
  if (inbound.mediaUrl && inbound.type !== "text" && paymentsEnabled) {
    // Marca que hay un comprobante leyéndose para esta conversación: el turno del
    // agente debe ESPERAR a que termine (y se guarde el código en lastReceipt) antes
    // de validar. Si no, un texto que llega aparte (ej. "Listo") dispara su turno con
    // el debounce ANTES de que la visión guarde el código → valida con code=[] →
    // pide el nombre del titular en vano → bucle. (race del debounce vs. visión)
    const rk = convo.conversationId;
    receiptReadsInFlight.set(rk, (receiptReadsInFlight.get(rk) ?? 0) + 1);
    try {
      await handleInboundImage(companyId, config, convo, inbound, userMessageId);
    } finally {
      const n = (receiptReadsInFlight.get(rk) ?? 1) - 1;
      if (n > 0) receiptReadsInFlight.set(rk, n);
      else receiptReadsInFlight.delete(rk);
    }
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

// Comprobantes (imágenes) que se están leyendo con visión, por conversación. Mientras
// haya uno en vuelo, el turno del agente se DIFIERE: debe ver el código leído
// (state.lastReceipt) antes de validar. Clave = conversationId. In-memory ⇒
// single-instance, igual que pendingTurns.
const receiptReadsInFlight = new Map<string, number>();
// Veces que un turno se difirió esperando una lectura de comprobante; tope de
// seguridad para que una visión colgada nunca bloquee el turno indefinidamente.
const turnDeferrals = new Map<string, number>();
const MAX_TURN_DEFERRALS = 10; // ~15s (10 × 1500ms)

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

  // Si hay un comprobante leyéndose para esta conversación, espera: el turno debe
  // ver el código (state.lastReceipt) antes de validar. Re-arma el timer corto y
  // sale sin correr. Tope de seguridad por si la visión se cuelga.
  const deferrals = turnDeferrals.get(key) ?? 0;
  if ((receiptReadsInFlight.get(key) ?? 0) > 0 && deferrals < MAX_TURN_DEFERRALS) {
    turnDeferrals.set(key, deferrals + 1);
    console.log(`[agent] turno diferido (comprobante en lectura) convo=${key} intento=${deferrals + 1}`);
    p.timer = setTimeout(() => {
      void fireTurn(key);
    }, 1500);
    return;
  }
  turnDeferrals.delete(key);

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

  // Memoria durable de compras: productos ya comprados/entregados (comprobantes
  // APROBADOS). Independiente de los últimos 16 mensajes de historial; se recalcula
  // cada turno y se inyecta al prompt para que el agente recuerde compras previas y
  // no se confunda con un catálogo de varios productos.
  ctx.state.purchasedProductIds = await getPurchasedProductIds(companyId, customerId);

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

  // Dedup de multimedia repetida en el mismo turno: si el modelo reenvía con
  // enviar_multimedia (fileIds, sin guard) un archivo que enviar_ficha ya mandó en
  // la presentación, llegaría dos veces. Nunca mandamos la misma URL dos veces en un
  // turno (los reenvíos legítimos que pide el cliente ocurren en turnos posteriores,
  // con un outbox nuevo, así que no se ven afectados).
  const seenMedia = new Set<string>();
  ctx.outbox = ctx.outbox.filter((m) => {
    if (m.kind !== "media" || !m.mediaUrl) return true;
    if (seenMedia.has(m.mediaUrl)) return false;
    seenMedia.add(m.mediaUrl);
    return true;
  });

  // Enviar adjuntos/mensajes acumulados por las herramientas, en orden
  await flushOutbox(sender, customerPhone, ctx.outbox, ctx);

  // Enviar y registrar el texto final (tras una pausa si ya se envió algo, para
  // que llegue DESPUÉS de la multimedia).
  if (finalText) {
    if (ctx.outbox.length) await sleep(OUTBOX_GAP_MS);
    await deliver(sender, customerPhone, { kind: "text", text: finalText }, ctx);
  }

  await saveState(conversationId, ctx.state);

  // Reconciliación: los follow-ups de abandono y dejado-en-visto son EXCLUYENTES y
  // scheduleAutoReminders es su único dueño. Cancelamos los PENDING de turnos previos
  // antes de regenerarlos, así no se acumulan ambos tipos para el mismo cliente (el
  // re-disparo `dirty` corre un 2º turno que no pasa por handleInbound, donde está la
  // otra cancelación). Va ANTES del loop de ctx.reminders para no pisar un recordatorio
  // que el modelo acabe de pedir en este turno; los manuales quedan protegidos por
  // cancelPendingReminders (NOT metadata.manual).
  await cancelPendingReminders(companyId, customerId, [
    ScheduledMessageType.ABANDONED_CART,
    ScheduledMessageType.LEFT_ON_READ,
  ]);

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

    // Llave = código de seguridad (Yape→Yape). El N° de operación no lo guarda ValidPay.
    const codes = [state.lastReceipt?.securityCode, md.operationCode]
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
      // Aviso al dueño por cada venta automática (entrega por inventario).
      if (result.autoSales?.length) {
        const adminPhone = (config.payment.notification?.whatsappPhone || config.business.adminPhone || "").replace(/\D/g, "");
        if (adminPhone) {
          for (const s of result.autoSales) {
            try {
              await sendText(sender, adminPhone, autoSaleNotice(s, md.customerPhone ?? to));
            } catch {
              /* best-effort */
            }
          }
        }
      }
      // Pasar a atención humana en este camino de auto-entrega (el modelo no llamó a
      // entregar_producto): por pauseHumanAfterSale, o por entrega manual / sin stock.
      if (result.shouldPauseHuman) {
        await muteCustomerToHuman(msg.companyId, conversationId, md.customerPhone ?? to);
        const adminPhone = (config.payment.notification?.whatsappPhone || config.business.adminPhone || "").replace(/\D/g, "");
        if (adminPhone) {
          const manual = result.manualNeeded ?? [];
          const adminMsg = manual.length
            ? `🔔 Pago confirmado de ${md.customerPhone ?? to}. Falta ENTREGAR MANUALMENTE: ${manual.join(", ")}.` +
              (result.outOfStock?.length ? ` ⚠️ SIN STOCK en inventario: ${result.outOfStock.join(", ")}.` : "") +
              ` El chat quedó en atención humana (Agente IA → Atención humana).`
            : `✅ Venta entregada a ${md.customerPhone ?? to}. Pasé el chat a atención humana automáticamente (configurado en el producto). Lo ves en Agente IA → Atención humana.`;
          try {
            await sendText(sender, adminPhone, adminMsg);
          } catch {
            /* best-effort */
          }
        }
      }
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
 * Imagen recibida del cliente. NO responde al cliente ni valida aquí: el AGENTE es
 * la ÚNICA voz. Esto le da "ojos" al agente (que es texto-only) y distingue dos casos:
 *
 *  A) Es un COMPROBANTE de pago (tiene datos leídos —monto/op/código— o el modelo lo
 *     clasifica como comprobante): guarda `state.lastReceipt` (el system prompt lo
 *     expone como `comprobanteLeido`) y reenvía el comprobante al admin como aviso. El
 *     turno (debounced) lo verá y llamará a validar_pago. — flujo de pago ACTUAL, intacto.
 *
 *  B) NO es comprobante (una foto cualquiera: producto, álbum, pantalla): NO se guarda
 *     como pago ni se avisa al dueño. Se anota en el mensaje del cliente QUÉ muestra la
 *     imagen (description) para que el agente la interprete y siga la conversación.
 */
async function handleInboundImage(
  companyId: string,
  config: Awaited<ReturnType<typeof buildBotConfig>>,
  convo: { conversationId: string; customerId: string; state: ConversationState },
  inbound: InboundMessage,
  userMessageId: string,
): Promise<void> {
  const imageUrl = inbound.mediaUrl;
  const fromPhone = inbound.fromPhone;
  if (!imageUrl || !fromPhone) return;

  // 1) Visión (best-effort; requiere la API key del tenant).
  const apiKey = (config as { openai?: { apiKey?: string | null } }).openai?.apiKey ?? null;
  const model = (config as { openai?: { model?: string } }).openai?.model || "gpt-4o-mini";
  const receipt = apiKey ? await readReceiptImage(apiKey, model, imageUrl).catch(() => null) : null;

  // Datos de pago leídos (llaves de validación). Si hay datos, es comprobante seguro.
  const looksLikeReceipt = !!(receipt && (receipt.amountText || receipt.securityCode || receipt.operationNumber));
  // Salvaguarda anti-regresión: un comprobante real pero borroso (sin datos) que el
  // modelo igual reconoce como pago SIGUE entrando al flujo de validación de siempre.
  const treatAsReceipt = looksLikeReceipt || receipt?.isReceipt === true;

  // CASO B — no es comprobante: anotar la descripción y dejar que el agente converse.
  if (!treatAsReceipt) {
    const hadCaption = !!(inbound.text && inbound.text.trim());
    if (!hadCaption && receipt?.description) {
      // El cliente mandó la imagen sin texto: anotamos qué muestra para que el agente
      // (texto-only) responda en contexto en vez de asumir que es un pago.
      await annotateMessageText(userMessageId, `[El cliente envió una imagen que muestra: ${receipt.description}]`);
    }
    console.log(`[agent] imagen de ${fromPhone}: NO es comprobante (desc="${receipt?.description ?? "-"}"); el agente la interpreta en contexto`);
    return;
  }

  // CASO A — comprobante: guardar lo leído (aunque sea parcial / nulo) para que el AGENTE
  // lo use en su turno y decida: con código valida solo; sin código pedirá el titular.
  convo.state.lastReceipt = {
    amountText: receipt?.amountText ?? null,
    time: receipt?.time ?? null,
    operationNumber: receipt?.operationNumber ?? null,
    securityCode: receipt?.securityCode ?? null,
    mediaUrl: imageUrl,
    at: new Date().toISOString(),
  };
  await saveState(convo.conversationId, convo.state);

  // Reenviar el comprobante al admin (solo aviso; NO pausa el bot, NO responde al cliente).
  const sender = await loadWhatsappSender(companyId);
  if (sender) {
    const adminPhone = (config.payment.notification?.whatsappPhone || config.business.adminPhone || "").replace(/\D/g, "");
    if (adminPhone) {
      const name = await getCustomerName(convo.customerId);
      const datos = looksLikeReceipt
        ? `Monto: ${receipt!.amountText ?? "—"}` +
          (receipt!.securityCode ? ` · cód: ${receipt!.securityCode}` : "") +
          (receipt!.operationNumber ? ` · op: ${receipt!.operationNumber}` : "")
        : "No se pudo leer automáticamente; revísalo.";
      const caption = `🧾 Comprobante recibido${name ? ` de ${name}` : ""} (${fromPhone}).\n${datos}`;
      try {
        await sendMedia(sender, adminPhone, "image", imageUrl, caption);
      } catch {
        /* best-effort */
      }
    }
  }

  console.log(
    `[agent] comprobante de ${fromPhone} leído (monto=${receipt?.amountText ?? "-"} cód=${receipt?.securityCode ?? "-"}); lo validará el agente en su turno`,
  );
}

/**
 * Memoria durable de compras: ids de productos que el cliente YA compró y se le
 * entregaron (comprobantes APROBADOS), juntando productIds (carrito) y productId
 * (compra de un solo producto). No depende del historial reciente.
 */
async function getPurchasedProductIds(companyId: string, customerId: string): Promise<string[]> {
  const receipts = await prisma.paymentReceipt.findMany({
    where: { companyId, customerId, status: "APROBADO" },
    select: { productIds: true, productId: true },
  });
  const ids = new Set<string>();
  for (const r of receipts) {
    for (const id of r.productIds ?? []) ids.add(id);
    if (r.productId) ids.add(r.productId);
  }
  return [...ids];
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
  // Id real del producto (no el slug) para poder filtrar/cancelar recordatorios por producto en el panel.
  const productId = product?.id ?? null;
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
      const meta: Record<string, unknown> = {};
      if (step.mediaType) meta.mediaType = step.mediaType;
      if (productId) meta.productId = productId;
      await scheduleReminder({
        companyId,
        customerId,
        conversationId,
        type: smType,
        sendAt: secondsFromNow(step.delaySeconds),
        body: step.message,
        mediaUrl: step.mediaUrl,
        metadata: Object.keys(meta).length ? (meta as Prisma.InputJsonValue) : undefined,
        timezone: config.business.timezone,
        quietHours: (followup as { quietHours?: unknown } | null)?.quietHours,
      });
    }
  };

  const status = state.status ?? "";

  // Estados terminales/humano/entregado: no programar seguimiento (el post-venta lo
  // cubren los mensajes adicionales tras la entrega del Paso 5).
  if (["ENTREGADO", "PEDIDO_REGISTRADO", "RESERVA_SOLICITADA", "ASESOR_HUMANO"].includes(status)) return;

  // Abandono de carrito y dejado en visto son EXCLUYENTES: un mismo silencio no debe
  // disparar dos secuencias que se encimarían (parece spam). Si hay carrito/compra
  // pendiente → solo abandono de carrito (más específico y accionable); si no → solo
  // dejado en visto.
  if (status === "ESPERANDO_PAGO" && (cart.items.length || state.selectedProductId)) {
    await scheduleSeq("abandonedCart", ScheduledMessageType.ABANDONED_CART);
  } else {
    await scheduleSeq("leftOnRead", ScheduledMessageType.LEFT_ON_READ);
  }
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
