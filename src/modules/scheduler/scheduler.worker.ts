/**
 * Worker de recordatorios. Cada 60s busca ScheduledMessage PENDING vencidas,
 * las envía por WhatsApp (SMS Tools) y las marca SENT/FAILED. In-process
 * (sin Redis), arrancado desde server.ts.
 */

import cron from "node-cron";
import { Prisma, ScheduledMessageStatus, ScheduledMessageType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { setCartUnitPrice } from "../agent/cart.service";
import { loadWhatsappSender, sendText, sendMedia, mediaKindFor } from "../agent/outbound";
import { applyFirma } from "../agent/firma";
import { recordMessage } from "../agent/conversation.service";
import { recheckPayment } from "../agent/agent.service";
import { resumeFlowOnTimeout } from "../flows/flow-engine";
import {
  clampToBusinessHours,
  normalizeQuietHours,
  normalizePacing,
  pacingDelayMs,
  type QuietHours,
  type ReminderPacing,
} from "./quiet-hours";
import { applySpintax } from "../agent/reminder-templates";
import { env } from "../../config/env";
import type { WhatsappSender } from "../agent/outbound";
import { metaWa, META_WINDOW_REASON } from "../../lib/meta-wa-client";
import {
  isWithin24hWindow,
  parseMetaTemplate,
  substituteTemplateParams,
  type MetaTemplateConfig,
} from "../agent/session-window";
import { symbolFor } from "../../lib/currency";

// La mayoría de filas vencidas de una pasada solo se REPROGRAMAN (pacing), así
// que el lote puede ser amplio sin que una empresa con muchos vencidos deje sin
// atender a las demás.
const BATCH = 300;
/** Tipos de SECUENCIA (varios pasos por cliente): se colapsan y vencen; el resto no. */
const SEQUENCE_TYPES: ScheduledMessageType[] = [ScheduledMessageType.ABANDONED_CART, ScheduledMessageType.LEFT_ON_READ];
const MAX_LATE_MS = env.REMINDER_MAX_LATE_HOURS * 60 * 60_000;
const MAX_LATE_LAST_MS = env.REMINDER_MAX_LATE_LAST_HOURS * 60 * 60_000;

/** Inyectable en tests (reloj). */
export const schedulerInternals = { now: () => new Date() };
// Separación mínima entre recordatorios VISIBLES al mismo cliente en una misma pasada
// del worker: evita que dos seguimientos lleguen pegados (parece spam). Configurable.
const MIN_GAP_MS = Number(process.env.REMINDER_MIN_GAP_MS) || 120_000;
// Si la empresa tiene una campaña enviando ahora mismo, el ritmo de los
// recordatorios se duplica para no sumar volumen a la campaña.
const CAMPAIGN_ACTIVE_WINDOW_MS = 10 * 60_000;
const CAMPAIGN_PACING_FACTOR = 2;

type QuietConfig = {
  tz: string | null;
  quiet: QuietHours;
  pacing: ReminderPacing;
  metaTemplate: MetaTemplateConfig | null;
};

/** Carga (y cachea por batch) la zona horaria + ventana de horario + ritmo del tenant. */
async function getQuietConfig(companyId: string, cache: Map<string, QuietConfig>): Promise<QuietConfig> {
  const hit = cache.get(companyId);
  if (hit) return hit;
  const [company, agentCfg] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { timezone: true } }),
    prisma.agentConfig.findUnique({ where: { companyId }, select: { followupConfig: true } }),
  ]);
  const followup = agentCfg?.followupConfig as { quietHours?: unknown; pacing?: unknown; metaTemplate?: unknown } | null;
  const quiet = normalizeQuietHours(followup?.quietHours);
  const cfg: QuietConfig = {
    tz: company?.timezone ?? null,
    quiet,
    pacing: normalizePacing(followup?.pacing, {
      minSec: env.REMINDER_PACING_MIN_SEC,
      maxSec: env.REMINDER_PACING_MAX_SEC,
      maxPerHour: env.REMINDER_MAX_PER_HOUR,
    }),
    // Plantilla de respaldo (tenants META) para recordatorios fuera de la
    // ventana de 24h. Sin plantilla, esos recordatorios se marcan FAILED.
    metaTemplate: parseMetaTemplate(followup?.metaTemplate),
  };
  cache.set(companyId, cfg);
  return cfg;
}

/**
 * Estado anti-ráfaga de una empresa dentro de una pasada: próximo instante en
 * que puede salir un recordatorio visible, cuántos salieron en la última hora
 * y si hay una campaña enviando ahora (ritmo ×2).
 */
type CompanyPace = {
  nextSlotMs: number;
  sentLastHour: number;
  campaignActive: boolean;
  /** Tope por hora alcanzado: próximo slot SECUENCIAL (arranca cuando el envío más
   *  antiguo de la última hora sale de la ventana). Mantiene el orden del lote. */
  capSlotMs: number;
};

async function getCompanyPace(companyId: string, now: Date, cache: Map<string, CompanyPace>): Promise<CompanyPace> {
  const hit = cache.get(companyId);
  if (hit) return hit;
  const hourAgo = new Date(now.getTime() - 60 * 60_000);
  const visible = { notIn: [ScheduledMessageType.FLOW_TIMEOUT, ScheduledMessageType.PAYMENT_RECHECK] };
  const [sentLastHour, oldestSent, campaign] = await Promise.all([
    prisma.scheduledMessage.count({
      where: { companyId, status: ScheduledMessageStatus.SENT, sentAt: { gte: hourAgo }, type: visible },
    }),
    prisma.scheduledMessage.findFirst({
      where: { companyId, status: ScheduledMessageStatus.SENT, sentAt: { gte: hourAgo }, type: visible },
      orderBy: { sentAt: "asc" },
      select: { sentAt: true },
    }),
    prisma.campaign.findFirst({
      where: { companyId, status: "RUNNING", nextSendAt: { gte: new Date(now.getTime() - CAMPAIGN_ACTIVE_WINDOW_MS) } },
      select: { id: true },
    }),
  ]);
  const capResetMs = oldestSent?.sentAt ? oldestSent.sentAt.getTime() + 60 * 60_000 : now.getTime() + 5 * 60_000;
  const pace: CompanyPace = {
    nextSlotMs: 0,
    sentLastHour,
    campaignActive: Boolean(campaign),
    capSlotMs: Math.max(capResetMs, now.getTime() + 60_000),
  };
  cache.set(companyId, pace);
  return pace;
}
let started = false;

export function startScheduler(): void {
  if (started) return;
  started = true;
  cron.schedule("* * * * *", () => {
    void processDue().catch((err) =>
      console.error("[scheduler] tick error:", err instanceof Error ? err.message : err),
    );
  });
  console.log("[scheduler] worker de recordatorios iniciado (cada 60s)");
}

type DueRow = Prisma.ScheduledMessageGetPayload<{ include: { customer: { select: { phone: true; name: true; optOutAt: true } } } }>;
type SeqMeta = { stepIndex?: unknown; dueAt?: unknown; offerPrice?: unknown; manual?: unknown; productId?: unknown };

function metaOf(row: { metadata: Prisma.JsonValue | null }): SeqMeta {
  const m = row.metadata;
  return m && typeof m === "object" && !Array.isArray(m) ? (m as SeqMeta) : {};
}
function stepIndexOf(row: { metadata: Prisma.JsonValue | null }): number | null {
  const v = Number(metaOf(row).stepIndex);
  return Number.isInteger(v) && v >= 0 ? v : null;
}
/** Hora planificada original (sendAt se mueve con el pacing). */
function dueAtOf(row: { sendAt: Date; metadata: Prisma.JsonValue | null }): number {
  const raw = metaOf(row).dueAt;
  const t = typeof raw === "string" ? new Date(raw).getTime() : NaN;
  return Number.isFinite(t) ? t : row.sendAt.getTime();
}
/** a es un paso MÁS NUEVO que b (por posición en la secuencia; si falta, por hora planificada). */
function isNewer(a: { sendAt: Date; metadata: Prisma.JsonValue | null }, b: { sendAt: Date; metadata: Prisma.JsonValue | null }): boolean {
  const ia = stepIndexOf(a);
  const ib = stepIndexOf(b);
  if (ia !== null && ib !== null && ia !== ib) return ia > ib;
  return dueAtOf(a) > dueAtOf(b);
}
/** Prioridad de envío: 0 = internos, citas, renovaciones, manuales y el PRIMER paso de una secuencia. */
function priorityOf(row: DueRow): number {
  if (
    row.type === ScheduledMessageType.FLOW_TIMEOUT ||
    row.type === ScheduledMessageType.PAYMENT_RECHECK ||
    row.type === ScheduledMessageType.BOOKING_REMINDER ||
    row.type === ScheduledMessageType.RENEWAL
  ) return 0;
  const meta = metaOf(row);
  if (meta.manual === true) return 0;
  if (SEQUENCE_TYPES.includes(row.type) && stepIndexOf(row) === 0) return 0;
  return 1;
}
function priceNumber(text: unknown): number | null {
  const n = Number(String(text ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function processDue(): Promise<void> {
  const now = schedulerInternals.now();
  const due = await prisma.scheduledMessage.findMany({
    where: { status: ScheduledMessageStatus.PENDING, sendAt: { lte: now } },
    orderBy: { sendAt: "asc" },
    take: BATCH,
    include: { customer: { select: { phone: true, name: true, optOutAt: true } } },
  });
  if (!due.length) return;
  // Orden justo: primero lo urgente y el PRIMER paso de cada lead (un lead nuevo no
  // espera detrás de pasos 4-6 atrasados); dentro de cada grupo, el que más espera.
  due.sort((a, b) => priorityOf(a) - priorityOf(b) || dueAtOf(a) - dueAtOf(b));
  const batchById = new Map(due.map((r) => [r.id, r]));

  const senderCache = new Map<string, WhatsappSender | null>();
  const quietCache = new Map<string, QuietConfig>();
  const paceCache = new Map<string, CompanyPace>();
  // Clientes que ya recibieron un recordatorio VISIBLE en esta pasada: el resto de
  // sus recordatorios se reprograma para no encimarse.
  const sentToCustomer = new Set<string>();
  const stats = { sent: 0, paced: 0, capped: 0, spread: 0, cancelled: 0, failed: 0, collapsed: 0, expired: 0 };

  for (const msg of due) {
    const isInternal =
      msg.type === ScheduledMessageType.FLOW_TIMEOUT || msg.type === ScheduledMessageType.PAYMENT_RECHECK;
    // Recordatorio de CITA: debe salir a SU hora exacta. Se exime del clamp de
    // horario hábil y del anti-spam (que lo correrían minutos u horas), igual
    // que los internos, pero sí es un mensaje visible para el cliente.
    const isBooking = msg.type === ScheduledMessageType.BOOKING_REMINDER;
    const keepExactTime = isInternal || isBooking;
    const custKey = `${msg.companyId}:${msg.customerId}`;

    // Guard de negocio (red de seguridad): un recordatorio de SEGUIMIENTO no debe
    // enviarse si el cliente ya pagó/cerró o si la conversación está en atención
    // humana (botPaused). Cubre filas programadas ANTES de que el cliente pagara o
    // se pausara (cuando la cancelación proactiva no alcanzó). Los internos
    // (FLOW_TIMEOUT/PAYMENT_RECHECK) se saltan el guard: deben correr siempre.
    if (!isInternal) {
      // Cliente que pidió NO ser contactado: nada visible sale, ni manual ni renovación.
      if (msg.customer.optOutAt) {
        await prisma.scheduledMessage.updateMany({
          where: { id: msg.id, status: ScheduledMessageStatus.PENDING },
          data: { status: ScheduledMessageStatus.CANCELLED, failureReason: "el cliente pidió no ser contactado" },
        });
        stats.cancelled += 1;
        continue;
      }
      // Visitante del chat web SIN WhatsApp (phone sintético "web:…"): no hay
      // adónde enviar el recordatorio. Si el visitante dejó su número real, el
      // recordatorio sale por WhatsApp normalmente (cross-channel).
      if (msg.customer.phone.startsWith("web:")) {
        await prisma.scheduledMessage.updateMany({
          where: { id: msg.id, status: ScheduledMessageStatus.PENDING },
          data: {
            status: ScheduledMessageStatus.CANCELLED,
            failureReason: "visitante del chat web sin número de WhatsApp",
          },
        });
        continue;
      }
      const convo = msg.conversationId
        ? await prisma.conversation.findUnique({
            where: { id: msg.conversationId },
            select: { botPaused: true, state: true },
          })
        : await prisma.conversation.findFirst({
            where: { companyId: msg.companyId, customerId: msg.customerId },
            orderBy: { updatedAt: "desc" },
            select: { botPaused: true, state: true },
          });
      const status = ((convo?.state as { status?: string } | null)?.status ?? "").toUpperCase();
      // RENEWAL (vencimiento de suscripción) ocurre JUSTO después de una venta cerrada
      // (ENTREGADO) y a veces con el chat en atención humana: debe dispararse igual.
      // Por eso se exime del cancel por "cerrado" y por "pausa". El resto de tipos
      // (ABANDONED_CART, LEFT_ON_READ, etc. — infoproductos) se comportan IGUAL que antes.
      // BOOKING_REMINDER se exime igual que RENEWAL: la cita existe aunque la
      // conversación esté "cerrada" (RESERVA_SOLICITADA es justamente el estado
      // que deja agendar) o en atención humana.
      const isRenewal = msg.type === ScheduledMessageType.RENEWAL || isBooking;
      const closed = !isRenewal && ["PAGADO", "ENTREGADO", "PEDIDO_REGISTRADO", "RESERVA_SOLICITADA", "ASESOR_HUMANO"].includes(status);
      // Recordatorio MANUAL (programado por un humano desde el panel): se envía
      // aunque la conversación esté en atención humana (botPaused) — para eso lo
      // creó el asesor. Igual se cancela si el cliente ya cerró/compró.
      const isManual = (msg.metadata as { manual?: boolean } | null)?.manual === true;
      const cancelForPause = convo?.botPaused && !isManual && !isRenewal;
      if (cancelForPause || closed) {
        await prisma.scheduledMessage.updateMany({
          where: { id: msg.id, status: ScheduledMessageStatus.PENDING },
          data: {
            status: ScheduledMessageStatus.CANCELLED,
            failureReason: closed ? `cliente en estado ${status}` : "conversación en atención humana",
          },
        });
        console.log(`[scheduler] recordatorio ${msg.type} cancelado (${closed ? status : "pausado"}) cliente=${msg.customerId}`);
        stats.cancelled += 1;
        continue;
      }
    }

    // Secuencias (carrito abandonado / dejado en visto): si este paso ya venció o
    // hay varios pasos atrasados del mismo cliente, se envía SOLO el más reciente
    // (con el precio de la oferta escalonada más avanzada) y el resto se cancela.
    if (SEQUENCE_TYPES.includes(msg.type)) {
      const verdict = await collapseOverdueSiblings(msg, now, stats, batchById);
      if (verdict === "skip") continue;
    }

    // Horario hábil: los mensajes al cliente (no los timeouts internos de flujo
    // ni los reintentos de pago, que son urgentes) no se envían fuera de la
    // ventana del tenant; se reprograman al próximo horario válido sin
    // reclamarlos (cubre filas viejas o creadas con anticipación).
    if (!keepExactTime) {
      const qc = await getQuietConfig(msg.companyId, quietCache);
      if (qc.tz) {
        const next = clampToBusinessHours(now, qc.tz, qc.quiet);
        if (next.getTime() > now.getTime()) {
          await prisma.scheduledMessage.updateMany({
            where: { id: msg.id, status: ScheduledMessageStatus.PENDING },
            data: { sendAt: next },
          });
          stats.spread += 1;
          continue;
        }
      }
    }

    // Anti-spam: si este cliente ya recibió un recordatorio visible en esta misma
    // pasada, no encimar el siguiente; reprogramarlo MIN_GAP_MS más tarde (sin
    // reclamarlo). En un tick posterior se reevalúa y vuelve a espaciarse si hace
    // falta, serializando la ráfaga con separación. Los internos no cuentan.
    if (!keepExactTime && sentToCustomer.has(custKey)) {
      await prisma.scheduledMessage.updateMany({
        where: { id: msg.id, status: ScheduledMessageStatus.PENDING },
        data: { sendAt: new Date(now.getTime() + MIN_GAP_MS) },
      });
      stats.paced += 1;
      continue;
    }

    // ANTI-RÁFAGA por empresa: los recordatorios visibles de una misma empresa
    // salen con separación al azar [minSec, maxSec] (×2 si tiene una campaña
    // enviando) y con tope por hora. Lo que no entra se REPROGRAMA al siguiente
    // slot (sin reclamarlo): la ráfaga de la apertura se vuelve goteo.
    let pace: CompanyPace | null = null;
    if (!keepExactTime) {
      const qc = await getQuietConfig(msg.companyId, quietCache);
      pace = await getCompanyPace(msg.companyId, now, paceCache);
      if (pace.sentLastHour >= qc.pacing.maxPerHour) {
        // Tope alcanzado: a slots SECUENCIALES desde que se libera la hora (antes
        // era +5-15 min al azar y la cola perdía el orden).
        await prisma.scheduledMessage.updateMany({
          where: { id: msg.id, status: ScheduledMessageStatus.PENDING },
          data: { sendAt: new Date(pace.capSlotMs) },
        });
        pace.capSlotMs += pacingDelayMs(qc.pacing, pace.campaignActive ? CAMPAIGN_PACING_FACTOR : 1);
        stats.capped += 1;
        continue;
      }
      if (pace.nextSlotMs > now.getTime()) {
        await prisma.scheduledMessage.updateMany({
          where: { id: msg.id, status: ScheduledMessageStatus.PENDING },
          data: { sendAt: new Date(pace.nextSlotMs) },
        });
        // El siguiente de esta empresa va aún más tarde (goteo acumulativo).
        pace.nextSlotMs += pacingDelayMs(qc.pacing, pace.campaignActive ? CAMPAIGN_PACING_FACTOR : 1);
        stats.paced += 1;
        continue;
      }
    }

    // Claim optimista: solo procede quien logra pasarlo de PENDING a SENT
    const claim = await prisma.scheduledMessage.updateMany({
      where: { id: msg.id, status: ScheduledMessageStatus.PENDING },
      data: { status: ScheduledMessageStatus.SENT, sentAt: new Date() },
    });
    if (claim.count === 0) continue;

    try {
      // Timeout de bloque de flujo: no envía un mensaje fijo, reanuda el motor
      // por la rama "sin responder" del bloque que quedó esperando.
      if (msg.type === ScheduledMessageType.FLOW_TIMEOUT) {
        await resumeFlowOnTimeout(msg);
        continue;
      }

      // Reintento de validación de pago: re-corre el matching y, si aparece,
      // aprueba y entrega; si no, deriva a un asesor (no es un mensaje fijo).
      if (msg.type === ScheduledMessageType.PAYMENT_RECHECK) {
        await recheckPayment({
          companyId: msg.companyId,
          customerId: msg.customerId,
          conversationId: msg.conversationId,
          metadata: msg.metadata,
        });
        continue;
      }

      if (!senderCache.has(msg.companyId)) {
        senderCache.set(msg.companyId, await loadWhatsappSender(msg.companyId));
      }
      const sender = senderCache.get(msg.companyId);
      if (!sender) throw new Error("empresa sin WhatsappConfig activa");

      const to = msg.customer.phone.replace(/\D/g, "");

      // Ventana de 24h de Meta: un recordatorio libre fuera de ventana sería
      // rechazado (131047). Con plantilla de respaldo configurada se envía la
      // plantilla; sin ella, FAILED con la razón visible en el panel.
      if (sender.provider === "META" && !(await isWithin24hWindow(msg.companyId, msg.customerId))) {
        const qc = await getQuietConfig(msg.companyId, quietCache);
        if (!qc.metaTemplate) throw new Error(META_WINDOW_REASON);
        const params = substituteTemplateParams(qc.metaTemplate.params, { nombre: msg.customer.name });
        await metaWa.sendTemplate(sender, to, qc.metaTemplate.name, qc.metaTemplate.language, params);
        if (msg.conversationId) {
          await recordMessage({
            companyId: msg.companyId,
            customerId: msg.customerId,
            conversationId: msg.conversationId,
            role: "ASSISTANT",
            message: `📋 Plantilla de Meta "${qc.metaTemplate.name}" enviada (recordatorio fuera de la ventana de 24h).`,
          });
        }
        sentToCustomer.add(custKey);
        markSent(pace, qc.pacing);
        continue;
      }

      // Spintax {a|b} resuelto AL ENVIAR: dos clientes no reciben el mismo texto.
      const body = (await applyFirma(msg.companyId, applySpintax(msg.body))) ?? applySpintax(msg.body);
      if (msg.mediaUrl) {
        // El tipo de media va en metadata (image|video|audio|pdf); default image.
        const mediaType = (msg.metadata as { mediaType?: string } | null)?.mediaType || "image";
        await sendMedia(sender, to, mediaKindFor(mediaType), msg.mediaUrl, body);
      } else {
        await sendText(sender, to, body);
      }

      // Registrar en la conversación para que aparezca en el panel
      if (msg.conversationId) {
        await recordMessage({
          companyId: msg.companyId,
          customerId: msg.customerId,
          conversationId: msg.conversationId,
          role: "ASSISTANT",
          message: body,
          mediaUrl: msg.mediaUrl,
        });
      }

      // Oferta ESCALONADA: al ENVIARSE este paso, el precio ofrecido queda activo
      // SOLO para este cliente — el agente lo presenta, cobra y valida en su
      // conversación (state.activeOffer) y el carrito se reprecia si ya tenía
      // el producto. Best-effort: si falla, el recordatorio igual se envió.
      const offerMeta = msg.metadata as { offerPrice?: string; productId?: string } | null;
      if (offerMeta?.offerPrice) {
        try {
          const offerNum = Number(String(offerMeta.offerPrice).replace(/[^0-9.]/g, ""));
          const offerCompany = await prisma.company.findUnique({ where: { id: msg.companyId }, select: { currency: true } });
          const priceText = offerNum > 0 ? `${symbolFor(offerCompany?.currency)} ${offerNum.toFixed(2)}` : null;
          if (priceText) {
            // Nunca retroceder: si el cliente ya tiene activa una oferta MENOR, se conserva.
            let keepLower = false;
            if (msg.conversationId) {
              const row = await prisma.conversation.findUnique({
                where: { id: msg.conversationId },
                select: { state: true },
              });
              const state = (row?.state ?? {}) as Record<string, unknown>;
              const current = priceNumber((state.activeOffer as { priceText?: unknown } | null)?.priceText);
              keepLower = current !== null && current < offerNum;
              if (!keepLower) {
                state.activeOffer = {
                  productId: offerMeta.productId ?? null,
                  priceText,
                  at: new Date().toISOString(),
                  source: "reminder",
                };
                await prisma.conversation.update({
                  where: { id: msg.conversationId },
                  data: { state: state as Prisma.InputJsonValue },
                });
              }
            }
            if (!keepLower && offerMeta.productId) {
              await setCartUnitPrice(msg.companyId, msg.customerId, offerMeta.productId, priceText);
            }
            console.log(
              keepLower
                ? `[scheduler] oferta escalonada ${priceText} NO aplicada: el cliente ya tiene una menor cliente=${msg.customerId}`
                : `[scheduler] oferta escalonada activada (${priceText}) cliente=${msg.customerId}`,
            );
          }
        } catch (err) {
          console.warn("[scheduler] no se pudo activar la oferta del recordatorio:", err instanceof Error ? err.message : err);
        }
      }

      // Marcar que este cliente ya recibió un recordatorio visible en esta pasada
      // (los siguientes se reprograman para no encimarse).
      sentToCustomer.add(custKey);
      if (pace) markSent(pace, (await getQuietConfig(msg.companyId, quietCache)).pacing);
    } catch (err) {
      stats.failed += 1;
      await prisma.scheduledMessage.update({
        where: { id: msg.id },
        data: {
          status: ScheduledMessageStatus.FAILED,
          failureReason: err instanceof Error ? err.message : "envío falló",
        },
      });
    }
  }

  if (stats.sent || stats.paced || stats.capped || stats.spread || stats.failed || stats.collapsed || stats.expired) {
    console.log(
      `[scheduler] pasada due=${due.length} enviados=${stats.sent} pacing=${stats.paced} tope=${stats.capped} dispersados=${stats.spread} cancelados=${stats.cancelled} colapsados=${stats.collapsed} vencidos=${stats.expired} fallidos=${stats.failed}`,
    );
  }

  /** Tras un envío visible: avanza el slot de la empresa y cuenta para el tope. */
  function markSent(p: CompanyPace | null, pacing: ReminderPacing): void {
    stats.sent += 1;
    if (!p) return;
    p.sentLastHour += 1;
    p.nextSlotMs = Date.now() + pacingDelayMs(pacing, p.campaignActive ? CAMPAIGN_PACING_FACTOR : 1);
  }
}

/**
 * Colapso + vencimiento de un paso de secuencia que está por enviarse.
 * - Vence si lleva > REMINDER_MAX_LATE_HOURS de atraso y hay un paso más nuevo
 *   pendiente (vencido o futuro), o > REMINDER_MAX_LATE_LAST_HOURS en cualquier caso.
 * - Si hay varios pasos vencidos del mismo cliente, gana el más reciente; los
 *   demás se cancelan. El precio de la oferta escalonada más avanzada entre los
 *   vencidos se traslada al ganador si este no trae uno.
 * Devuelve "skip" si la fila actual no debe enviarse.
 */
async function collapseOverdueSiblings(
  msg: DueRow,
  now: Date,
  stats: { collapsed: number; expired: number },
  batchById: Map<string, DueRow>,
): Promise<"send" | "skip"> {
  const siblings = await prisma.scheduledMessage.findMany({
    where: { companyId: msg.companyId, customerId: msg.customerId, type: msg.type, status: ScheduledMessageStatus.PENDING },
    orderBy: { sendAt: "asc" },
    select: { id: true, sendAt: true, metadata: true },
  });
  const me = siblings.find((r) => r.id === msg.id) ?? { id: msg.id, sendAt: msg.sendAt, metadata: msg.metadata };
  const nowMs = now.getTime();
  const lateMs = nowMs - dueAtOf(me);
  const hasNewer = siblings.some((r) => r.id !== me.id && isNewer(r, me));
  if (lateMs > MAX_LATE_LAST_MS || (lateMs > MAX_LATE_MS && hasNewer)) {
    await prisma.scheduledMessage.updateMany({
      where: { id: me.id, status: ScheduledMessageStatus.PENDING },
      data: {
        status: ScheduledMessageStatus.CANCELLED,
        failureReason: hasNewer
          ? "venció: se envía el paso más reciente de la secuencia"
          : `venció: más de ${env.REMINDER_MAX_LATE_LAST_HOURS} h de atraso`,
      },
    });
    stats.expired += 1;
    return "skip";
  }

  // "Vencido" = su hora PLANIFICADA ya pasó (sendAt puede estar corrido unos
  // segundos/minutos por el pacing y aun así el paso está atrasado).
  const overdue = siblings.filter((r) => dueAtOf(r) <= nowMs);
  if (overdue.length <= 1) return "send";
  const winner = overdue.reduce((best, r) => (isNewer(r, best) ? r : best));
  const losers = overdue.filter((r) => r.id !== winner.id);
  const carrier = overdue
    .filter((r) => priceNumber(metaOf(r).offerPrice) !== null)
    .reduce<(typeof overdue)[number] | null>((best, r) => (!best || isNewer(r, best) ? r : best), null);
  const winnerStep = stepIndexOf(winner);
  await prisma.scheduledMessage.updateMany({
    where: { id: { in: losers.map((r) => r.id) }, status: ScheduledMessageStatus.PENDING },
    data: {
      status: ScheduledMessageStatus.CANCELLED,
      failureReason: `colapsado: se envía el paso${winnerStep !== null ? ` ${winnerStep + 1}` : ""} más reciente (el cliente tenía ${overdue.length} atrasados)`,
    },
  });
  stats.collapsed += losers.length;
  // Oferta escalonada: el ganador hereda el precio del paso vencido más avanzado que la traía.
  if (carrier && carrier.id !== winner.id && priceNumber(metaOf(winner).offerPrice) === null) {
    const carried = metaOf(carrier);
    const merged = { ...metaOf(winner), offerPrice: carried.offerPrice, carriedFromStep: stepIndexOf(carrier), productId: metaOf(winner).productId ?? carried.productId ?? null };
    await prisma.scheduledMessage.update({ where: { id: winner.id }, data: { metadata: merged as Prisma.InputJsonValue } });
    // El ganador puede venir más adelante en este mismo lote: actualizar su copia en memoria.
    const inBatch = batchById.get(winner.id);
    if (inBatch) inBatch.metadata = merged as Prisma.JsonValue;
    if (winner.id === me.id) msg.metadata = merged as Prisma.JsonValue;
  }
  if (winner.id !== me.id) return "skip";
  return "send";
}
