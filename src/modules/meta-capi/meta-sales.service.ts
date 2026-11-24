/**
 * Punto ÚNICO para reportar ventas a Meta (Conversions API).
 *
 * Toda ruta que confirma una venta llama a `recordSaleForMeta` (chat) o a
 * `reportStorePurchase` (tienda web). Aquí se decide:
 *  - qué VENTA es (un comprobante suelto o un pedido: una sola compra por pedido,
 *    con el total, aunque se pague en adelanto + saldo);
 *  - con qué CLIC de anuncio se reporta (el más reciente anterior a la venta);
 *  - que no se duplique (MetaConversionEvent.eventKey único por empresa: Meta NO
 *    deduplica eventos de mensajería) y que se reintente si Meta o la red fallan.
 *
 * Todo best-effort y never-throw: un fallo aquí jamás rompe una aprobación.
 */

import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { decryptCredential } from "../../lib/credentials-crypto";
import { parseMoney } from "../../lib/money";

const sha256 = (v: string) => crypto.createHash("sha256").update(v).digest("hex");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Un pago y un pedido del mismo cliente dentro de esta ventana son la MISMA venta. */
const SAME_SALE_WINDOW_MS = DAY;
/** Meta rechaza eventos con más de 7 días: pasado este margen se envía con la fecha actual. */
const MAX_EVENT_AGE_MS = 6 * DAY;
/** Esperas entre reintentos (red caída, 5xx, límite de Meta). Luego queda como fallido. */
const RETRY_DELAYS_MS = [5 * 60 * 1000, 30 * 60 * 1000, 2 * HOUR, 6 * HOUR, 12 * HOUR, DAY, DAY];

// El lector de montos vive en lib/money.ts (lo comparte el dashboard).
export { parseMoney };

/** Fecha del evento para Meta: la del pago; si es muy antigua o futura, ahora. Puro. */
export function eventTimeFor(paidAt: Date | null | undefined, now = new Date()): Date {
  if (!paidAt) return now;
  const age = now.getTime() - paidAt.getTime();
  return age < 0 || age > MAX_EVENT_AGE_MS ? now : paidAt;
}

export interface AdClick {
  adSourceId: string | null;
  adTitle: string | null;
  ctwaClid: string | null;
  at: Date | null;
}

/**
 * Clic de anuncio vigente de un cliente en un momento dado: el toque más reciente
 * ANTERIOR a la venta (con 2 min de margen por relojes). Si no hay toques (cliente
 * de antes de esta función), usa el último guardado en su ficha.
 */
export async function adClickFor(customerId: string, at: Date = new Date()): Promise<AdClick | null> {
  const touch = await prisma.adTouch.findFirst({
    where: { customerId, createdAt: { lte: new Date(at.getTime() + 2 * 60 * 1000) } },
    orderBy: { createdAt: "desc" },
    select: { adSourceId: true, adTitle: true, ctwaClid: true, createdAt: true },
  });
  if (touch) return { adSourceId: touch.adSourceId, adTitle: touch.adTitle, ctwaClid: touch.ctwaClid?.trim() || null, at: touch.createdAt };
  const c = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { adSourceId: true, adTitle: true, ctwaClid: true, lastAdSourceId: true, lastAdTitle: true, lastCtwaClid: true, lastAdAt: true, createdAt: true },
  });
  if (!c) return null;
  const adSourceId = c.lastAdSourceId ?? c.adSourceId;
  if (!adSourceId) return null;
  return {
    adSourceId,
    adTitle: c.lastAdTitle ?? c.adTitle,
    ctwaClid: (c.lastCtwaClid ?? c.ctwaClid)?.trim() || null,
    at: c.lastAdAt ?? c.createdAt,
  };
}

/** Deja en el comprobante el anuncio vigente al momento de la venta (solo si está vacío). */
async function stampReceiptAd(receiptId: string, click: AdClick | null): Promise<void> {
  if (!click?.adSourceId) return;
  await prisma.paymentReceipt
    .updateMany({ where: { id: receiptId, adSourceId: null }, data: { adSourceId: click.adSourceId, adTitle: click.adTitle } })
    .catch(() => undefined);
}

/** Resultado del último intento en la tarjeta del panel (Integraciones → Meta). */
async function recordAttempt(companyId: string, result: string): Promise<void> {
  await prisma.metaCapiConfig
    .update({ where: { companyId }, data: { lastAttemptAt: new Date(), lastResult: result.slice(0, 500) } })
    .catch(() => undefined);
}

const isUnique = (err: unknown) => (err as { code?: string })?.code === "P2002";
const metaOf = (v: Prisma.JsonValue | null | undefined) =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const RECEIPT_SELECT = {
  id: true,
  status: true,
  customerId: true,
  orderId: true,
  amountPaid: true,
  amountExpected: true,
  currency: true,
  occurredAt: true,
  validatedAt: true,
  metadata: true,
  adSourceId: true,
} as const;

const ORDER_SELECT = {
  id: true,
  customerId: true,
  source: true,
  status: true,
  orderCode: true,
  total: true,
  totalAmount: true,
  createdAt: true,
} as const;

/**
 * Registra una venta del CHAT (comprobante aprobado y/o pedido confirmado) y la
 * envía a Meta. Idempotente: llamarla dos veces por la misma venta no duplica.
 *
 * - `receiptId`: comprobante APROBADO. Si está ligado a un pedido, la venta es el pedido.
 * - `orderId`: pedido confirmado (contraentrega al registrarse, primer pago, o
 *   marcado pagado/entregado).
 * Sin cliente ligado todavía no hace nada: se vuelve a llamar al vincularlo.
 */
export async function recordSaleForMeta(
  companyId: string,
  ref: { receiptId?: string | null; orderId?: string | null },
): Promise<void> {
  try {
    const receipt = ref.receiptId
      ? await prisma.paymentReceipt.findFirst({ where: { id: ref.receiptId, companyId }, select: RECEIPT_SELECT })
      : null;
    if (ref.receiptId && (!receipt || receipt.status !== "APROBADO")) return;
    const receiptMeta = metaOf(receipt?.metadata);
    // Tienda web: tiene su propia ruta (evento de sitio web), nunca la del chat.
    if (receiptMeta.channel === "storefront") return;

    const orderRef = ref.orderId ?? receipt?.orderId ?? null;
    let order = orderRef && UUID_RE.test(orderRef)
      ? await prisma.order.findFirst({ where: { id: orderRef, companyId }, select: ORDER_SELECT })
      : null;
    if (order?.source === "WEB") return;
    if (order?.status === "CANCELADO") order = null;
    if (!receipt && !order) return;

    const customerId = order?.customerId ?? receipt?.customerId ?? null;
    if (!customerId) return;

    const saleAt = receipt?.validatedAt ?? new Date();
    const click = await adClickFor(customerId, saleAt);
    // El anuncio queda en el comprobante aunque el negocio no use Conversions API:
    // lo lee «Rendimiento por anuncio».
    if (receipt) await stampReceiptAd(receipt.id, click);

    const config = await prisma.metaCapiConfig.findUnique({ where: { companyId } });
    if (!config?.enabled || !config.datasetId || !config.accessToken) return;
    // Histórico: ventas reportadas antes de existir la cola.
    if (receiptMeta.capiSentAt) return;

    // ---- ¿Qué venta es? ----
    let eventKey: string;
    if (order) {
      eventKey = `order:${order.id}`;
      // El pago de este pedido ya se reportó como comprobante suelto (pedido «de
      // siempre», registrado antes o después de pagar): es la misma venta. Solo
      // pedidos sin montos: con «Envíos» el comprobante se liga al pedido de forma exacta.
      const paidAlready = order.totalAmount != null ? null : await prisma.metaConversionEvent.findFirst({
        where: {
          companyId,
          customerId,
          kind: "CHAT",
          eventKey: { startsWith: "receipt:" },
          status: { not: "SKIPPED" },
          createdAt: { gte: new Date(order.createdAt.getTime() - SAME_SALE_WINDOW_MS) },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, receiptId: true },
      });
      if (paidAlready?.receiptId) {
        const linked = await prisma.paymentReceipt.findUnique({ where: { id: paidAlready.receiptId }, select: { orderId: true } });
        if (!linked?.orderId || linked.orderId === order.id) {
          if (!linked?.orderId) {
            await prisma.paymentReceipt.updateMany({ where: { id: paidAlready.receiptId, orderId: null }, data: { orderId: order.id } });
          }
          return;
        }
      }
    } else {
      eventKey = `receipt:${receipt!.id}`;
      // El cliente tiene un pedido ya reportado (p. ej. contraentrega) y ahora llega
      // su pago sin vínculo explícito: es la misma venta.
      const recentOrder = await prisma.metaConversionEvent.findFirst({
        where: {
          companyId,
          customerId,
          kind: "CHAT",
          eventKey: { startsWith: "order:" },
          status: { not: "SKIPPED" },
          createdAt: { gte: new Date(Date.now() - SAME_SALE_WINDOW_MS) },
        },
        orderBy: { createdAt: "desc" },
        select: { orderId: true },
      });
      if (recentOrder?.orderId && UUID_RE.test(recentOrder.orderId)) {
        const open = await prisma.order.findFirst({
          // Solo pedidos «de siempre» (sin montos) y aún abiertos.
          where: { id: recentOrder.orderId, companyId, totalAmount: null, status: { notIn: ["ENTREGADO", "CANCELADO"] } },
          select: { id: true },
        });
        if (open) {
          await prisma.paymentReceipt.updateMany({ where: { id: receipt!.id, orderId: null }, data: { orderId: open.id } });
          return;
        }
      }
    }
    const exists = await prisma.metaConversionEvent.findUnique({
      where: { companyId_eventKey: { companyId, eventKey } },
      select: { id: true },
    });
    if (exists) return;

    // ---- Monto y moneda ----
    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { currency: true } });
    const receiptValue = receipt
      ? parseMoney(receipt.amountPaid) || parseMoney(receipt.amountExpected) || parseMoney(receiptMeta.expectedAmount)
      : 0;
    const value = order ? Number(order.totalAmount ?? 0) || parseMoney(order.total) || receiptValue : receiptValue;
    const currency = ((order ? null : receipt?.currency) || company?.currency || receipt?.currency || "PEN").toUpperCase();
    const eventTime = eventTimeFor(receipt?.occurredAt ?? receipt?.validatedAt ?? null);

    const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { phone: true } });
    const phoneDigits = (customer?.phone ?? "").replace(/\D/g, "");
    const ctwaClid = click?.ctwaClid ?? null;

    let skip: string | null = null;
    if (!(value > 0)) skip = "Omitido: la venta no tiene un monto válido.";
    else if (!ctwaClid && !(config.reportWithoutClick && config.pageId && phoneDigits)) {
      skip = "Omitido: el cliente no llegó desde un anuncio (sin clic guardado).";
    }

    const payload = {
      event_name: "Purchase",
      event_time: Math.floor(eventTime.getTime() / 1000),
      // Para comprobantes sueltos se conserva el id de siempre (receipt.id).
      event_id: order ? `order-${order.id}` : receipt!.id,
      action_source: "business_messaging",
      messaging_channel: "whatsapp",
      user_data: {
        ...(ctwaClid ? { ctwa_clid: ctwaClid } : {}),
        // Meta exige el page_id de la página que corre los anuncios.
        ...(config.pageId ? { page_id: config.pageId } : {}),
        ...(phoneDigits ? { ph: [sha256(phoneDigits)] } : {}),
      },
      custom_data: { currency, value },
    };

    let created: { id: string };
    try {
      created = await prisma.metaConversionEvent.create({
        data: {
          companyId,
          eventKey,
          kind: "CHAT",
          status: skip ? "SKIPPED" : "PENDING",
          receiptId: receipt?.id ?? null,
          orderId: order?.id ?? null,
          customerId,
          adSourceId: click?.adSourceId ?? null,
          adTitle: click?.adTitle ?? null,
          hasClick: !!ctwaClid,
          value: value > 0 ? new Prisma.Decimal(value.toFixed(2)) : null,
          currency,
          eventTime,
          payload: skip ? Prisma.JsonNull : (payload as Prisma.InputJsonValue),
          lastError: skip,
          nextAttemptAt: skip ? null : new Date(),
        },
        select: { id: true },
      });
    } catch (err) {
      if (isUnique(err)) return; // otra llamada simultánea ya registró esta venta
      throw err;
    }
    if (skip) {
      await recordAttempt(companyId, skip);
      return;
    }
    await deliverMetaEvent(created.id);
  } catch (err) {
    console.warn("[meta-capi] no se pudo registrar la venta:", err instanceof Error ? err.message : err);
  }
}

/** Alias histórico: reporta la venta de un comprobante aprobado. */
export async function reportCtwaConversion(companyId: string, receiptId: string): Promise<void> {
  return recordSaleForMeta(companyId, { receiptId });
}

/** Un pedido se canceló: su compra aún no enviada ya no se reporta. */
export async function cancelPendingOrderEvent(companyId: string, orderId: string): Promise<void> {
  await prisma.metaConversionEvent
    .updateMany({
      where: { companyId, eventKey: `order:${orderId}`, status: { in: ["PENDING", "FAILED"] } },
      data: { status: "SKIPPED", nextAttemptAt: null, lastError: "Omitido: el pedido se canceló antes de enviarse." },
    })
    .catch(() => undefined);
}

/**
 * Envía un evento de la cola a Meta. Toma el evento con un «candado» de 10 min
 * (el envío inmediato y el worker no lo mandan dos veces). Errores 4xx de Meta son
 * definitivos (el evento está mal formado); red, 5xx y 429 se reintentan.
 */
export async function deliverMetaEvent(eventId: string): Promise<void> {
  try {
    const ev = await prisma.metaConversionEvent.findUnique({ where: { id: eventId } });
    if (!ev || (ev.status !== "PENDING" && ev.status !== "FAILED") || !ev.payload) return;
    const lease = await prisma.metaConversionEvent.updateMany({
      where: { id: ev.id, status: ev.status, attempts: ev.attempts },
      data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + 10 * 60 * 1000) },
    });
    if (!lease.count) return;
    const attempts = ev.attempts + 1;

    const config = await prisma.metaCapiConfig.findUnique({ where: { companyId: ev.companyId } });
    if (!config?.enabled || !config.datasetId || !config.accessToken) {
      await prisma.metaConversionEvent.update({
        where: { id: ev.id },
        data: { status: "SKIPPED", nextAttemptAt: null, lastError: "Omitido: Conversions API está apagada." },
      });
      return;
    }
    const where = ev.kind === "STORE" ? "tienda web" : "chat";
    const label = `${ev.currency ?? ""} ${ev.value ? Number(ev.value) : 0}`.trim();
    const failLater = async (detail: string, retryable: boolean) => {
      const delay = retryable ? RETRY_DELAYS_MS[attempts - 1] : undefined;
      await prisma.metaConversionEvent.update({
        where: { id: ev.id },
        data: { status: "FAILED", lastError: detail.slice(0, 500), nextAttemptAt: delay ? new Date(Date.now() + delay) : null },
      });
      await recordAttempt(ev.companyId, `${detail}${delay ? " Se reintentará." : ""}`);
    };

    let res: Response;
    try {
      const token = decryptCredential(config.accessToken);
      const url = `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${config.datasetId}/events?access_token=${encodeURIComponent(token)}`;
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: [ev.payload], ...(config.testEventCode ? { test_event_code: config.testEventCode } : {}) }),
      });
    } catch (err) {
      await failLater(`Error de red al enviar la venta (${where}): ${err instanceof Error ? err.message : "desconocido"}.`, true);
      return;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn(`[meta-capi] ${where}: Meta respondió ${res.status}: ${detail.slice(0, 300)}`);
      await failLater(`Error de Meta en venta (${where}) (${res.status}): ${detail.slice(0, 300)}`, res.status >= 500 || res.status === 429);
      return;
    }
    await prisma.metaConversionEvent.update({
      where: { id: ev.id },
      data: { status: "SENT", sentAt: new Date(), nextAttemptAt: null, lastError: null },
    });
    await recordAttempt(
      ev.companyId,
      `OK: Purchase de ${label} reportado (${where}${ev.kind === "CHAT" && !ev.hasClick ? ", sin clic de anuncio" : ""})${config.testEventCode ? ` (modo prueba ${config.testEventCode})` : ""}.`,
    );
    console.log(`[meta-capi] Purchase reportado (${ev.eventKey}, valor=${label}, clic=${ev.hasClick})`);
  } catch (err) {
    console.warn("[meta-capi] envío de evento falló:", err instanceof Error ? err.message : err);
  }
}

/** Reintenta lo pendiente o fallido cuya espera ya venció (lo llama el worker). */
export async function retryDueMetaEvents(limit = 25): Promise<number> {
  const due = await prisma.metaConversionEvent.findMany({
    where: { status: { in: ["PENDING", "FAILED"] }, nextAttemptAt: { lte: new Date() } },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
    select: { id: true },
  });
  for (const ev of due) await deliverMetaEvent(ev.id);
  return due.length;
}

let workerTimer: NodeJS.Timeout | null = null;
/** Worker de reintentos de compras a Meta: cada 5 minutos. */
export function startMetaEventsWorker(): void {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    void retryDueMetaEvents().catch((err) => console.warn("[meta-capi] worker:", err instanceof Error ? err.message : err));
  }, 5 * 60 * 1000);
  workerTimer.unref?.();
}

export type StoreWebClient = { ip?: string | null; ua?: string | null; fbp?: string | null; fbc?: string | null; url?: string | null; sessionId?: string | null };

/**
 * Compra de la TIENDA WEB (action_source website). Una sola por pedido de la tienda
 * (`store:<orderId>`); event_id = id del pedido, el mismo que usa el píxel en la
 * página de gracias. Con `receiptId` exige que el comprobante esté APROBADO; sin él
 * (contraentrega) reporta el pedido confirmado con `value`. Nunca lanza.
 */
export async function reportStorePurchase(input: {
  companyId: string;
  receiptId?: string | null;
  orderId: string;
  /** Opcional: la tienda física puede no tener correo (ahí identifica el teléfono). */
  email?: string | null;
  phone?: string | null;
  customerId?: string | null;
  productIds: string[];
  client?: StoreWebClient | null;
  /** Total del pedido. Si falta, se usa el monto del comprobante. */
  value?: number | null;
  currency?: string | null;
}): Promise<void> {
  const { companyId } = input;
  try {
    const receipt = input.receiptId
      ? await prisma.paymentReceipt.findFirst({ where: { id: input.receiptId, companyId }, select: RECEIPT_SELECT })
      : null;
    if (input.receiptId && (!receipt || receipt.status !== "APROBADO")) return;
    const config = await prisma.metaCapiConfig.findUnique({ where: { companyId } });
    if (!config?.enabled || !config.datasetId || !config.accessToken) return;
    if (metaOf(receipt?.metadata).capiSentAt) return;

    const eventKey = `store:${input.orderId}`;
    const exists = await prisma.metaConversionEvent.findUnique({ where: { companyId_eventKey: { companyId, eventKey } }, select: { id: true } });
    if (exists) return;

    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { currency: true } });
    const value = (input.value && input.value > 0 ? Math.round(input.value * 100) / 100 : 0) || (receipt ? parseMoney(receipt.amountPaid) || parseMoney(receipt.amountExpected) : 0);
    const currency = (input.currency || receipt?.currency || company?.currency || "PEN").toUpperCase();
    const eventTime = eventTimeFor(receipt?.occurredAt ?? receipt?.validatedAt ?? null);
    const phoneDigits = (input.phone ?? "").replace(/\D/g, "");
    const email = (input.email ?? "").trim().toLowerCase();
    const c = input.client ?? {};
    const skip = value > 0 ? null : "Omitido: la venta de la tienda no tiene un monto válido.";
    const payload = {
      event_name: "Purchase",
      event_time: Math.floor(eventTime.getTime() / 1000),
      event_id: input.orderId,
      action_source: "website",
      ...(c.url ? { event_source_url: c.url } : {}),
      user_data: {
        ...(email ? { em: [sha256(email)] } : {}),
        ...(phoneDigits ? { ph: [sha256(phoneDigits)] } : {}),
        ...(input.customerId ? { external_id: [sha256(input.customerId)] } : {}),
        ...(c.ip ? { client_ip_address: c.ip } : {}),
        ...(c.ua ? { client_user_agent: c.ua } : {}),
        ...(c.fbp ? { fbp: c.fbp } : {}),
        ...(c.fbc ? { fbc: c.fbc } : {}),
      },
      custom_data: {
        currency,
        value,
        content_type: "product",
        content_ids: input.productIds,
        num_items: input.productIds.length,
      },
    };
    let created: { id: string };
    try {
      created = await prisma.metaConversionEvent.create({
        data: {
          companyId,
          eventKey,
          kind: "STORE",
          status: skip ? "SKIPPED" : "PENDING",
          receiptId: receipt?.id ?? null,
          orderId: input.orderId,
          customerId: input.customerId ?? null,
          adSourceId: "storefront",
          adTitle: "Tienda web",
          value: value > 0 ? new Prisma.Decimal(value.toFixed(2)) : null,
          currency,
          eventTime,
          payload: skip ? Prisma.JsonNull : (payload as Prisma.InputJsonValue),
          lastError: skip,
          nextAttemptAt: skip ? null : new Date(),
        },
        select: { id: true },
      });
    } catch (err) {
      if (isUnique(err)) return;
      throw err;
    }
    if (!skip) await deliverMetaEvent(created.id);
  } catch (err) {
    console.warn("[meta-capi] tienda: no se pudo registrar la compra:", err instanceof Error ? err.message : err);
  }
}

/** Últimas compras reportadas (o intentadas) a Meta, para el panel y el Copiloto. */
export async function listMetaEvents(companyId: string, limit = 30) {
  const take = Math.min(Math.max(1, limit), 100);
  const [rows, counts] = await Promise.all([
    prisma.metaConversionEvent.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" },
      take,
      select: {
        id: true,
        kind: true,
        status: true,
        adSourceId: true,
        adTitle: true,
        hasClick: true,
        value: true,
        currency: true,
        eventTime: true,
        attempts: true,
        lastError: true,
        sentAt: true,
        createdAt: true,
        customerId: true,
      },
    }),
    prisma.metaConversionEvent.groupBy({
      by: ["status"],
      where: { companyId, createdAt: { gte: new Date(Date.now() - 30 * DAY) } },
      _count: { _all: true },
    }),
  ]);
  const ids = [...new Set(rows.map((r) => r.customerId).filter((id): id is string => !!id))];
  const customers = ids.length
    ? await prisma.customer.findMany({ where: { id: { in: ids }, companyId }, select: { id: true, name: true, phone: true } })
    : [];
  const byId = new Map(customers.map((c) => [c.id, c]));
  const summary: Record<string, number> = { SENT: 0, PENDING: 0, FAILED: 0, SKIPPED: 0 };
  for (const c of counts) summary[c.status] = c._count._all;
  return {
    last30Days: summary,
    events: rows.map(({ customerId, value, ...r }) => ({
      ...r,
      value: value == null ? null : Number(value),
      customer: customerId ? byId.get(customerId) ?? null : null,
    })),
  };
}
