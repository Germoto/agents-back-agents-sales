/**
 * Lector ÚNICO de ventas del dashboard (tarjetas, «Por anuncio», Excel y reportes).
 *
 * Una venta es:
 *  - un comprobante APROBADO con producto que no pertenece a un pedido con montos, o
 *  - un pedido con montos (Order.totalAmount): UNA venta por pedido con su total,
 *    fechada en su primer pago, o al registrarse si es contraentrega confirmada.
 *    Sus comprobantes (adelanto, saldo) no se cuentan aparte. Cancelados fuera.
 * Los pedidos «de siempre» (sin montos) siguen contándose por sus comprobantes.
 * Mismo criterio que lo reportado a Meta (meta-capi/meta-sales.service.ts).
 */

import { prisma } from "../../lib/prisma";
import { parseMoney } from "../../lib/money";

export interface SaleShare {
  productId: string;
  amount: number;
  units: number;
}

export interface Sale {
  key: string; // receipt:<id> | order:<id>
  kind: "receipt" | "order";
  at: Date;
  amount: number;
  customerId: string | null;
  shares: SaleShare[];
  paymentSource: string | null;
  validationMode: string | null;
  adSourceId: string | null;
  adTitle: string | null;
  channel: "chat" | "store";
  // Detalle para el Excel.
  payerName: string | null;
  payerPhone: string | null;
  operationCode: string | null;
  reference: string | null;
  source: string | null;
  matchScore: number | null;
  orderCode: string | null;
}

// Contraentrega: sin pagos, pero el pedido ya está confirmado o más adelante.
const CONFIRMED_WITHOUT_PAYMENT = ["EN_COORDINACION", "DESPACHADO", "LISTO_PARA_RECOGER", "ENTREGADO", "PAGADO"];

const r2 = (n: number) => Math.round(n * 100) / 100;
const receiptAt = (r: { occurredAt: Date | null; validatedAt: Date | null; createdAt: Date }) =>
  r.occurredAt ?? r.validatedAt ?? r.createdAt;

/** Reparte `total` entre líneas según su peso (partes iguales si no hay pesos). Suma exacta. */
export function splitAmount(total: number, lines: Array<{ productId: string; weight: number; units: number }>): SaleShare[] {
  const merged = new Map<string, { weight: number; units: number }>();
  for (const l of lines) {
    const m = merged.get(l.productId) ?? { weight: 0, units: 0 };
    m.weight += l.weight > 0 ? l.weight : 0;
    m.units += l.units;
    merged.set(l.productId, m);
  }
  const entries = [...merged.entries()];
  if (!entries.length) return [];
  const sum = entries.reduce((a, [, m]) => a + m.weight, 0);
  let left = r2(total);
  return entries.map(([productId, m], i) => {
    const last = i === entries.length - 1;
    const amount = last ? r2(left) : r2(total * (sum > 0 ? m.weight / sum : 1 / entries.length));
    left -= amount;
    return { productId, amount: Math.max(0, amount), units: m.units };
  });
}

/** Ventas con fecha en [from, to], ordenadas por fecha. */
export async function loadSales(companyId: string, from: Date, to: Date): Promise<Sale[]> {
  const range = { gte: from, lte: to };
  const [receipts, orders] = await Promise.all([
    prisma.paymentReceipt.findMany({
      where: {
        companyId,
        status: "APROBADO",
        OR: [{ productId: { not: null } }, { productIds: { isEmpty: false } }],
        AND: [{ OR: [{ occurredAt: range }, { validatedAt: range }, { createdAt: range }] }],
      },
      select: {
        id: true,
        orderId: true,
        amountPaid: true,
        amountExpected: true,
        paymentSource: true,
        validationMode: true,
        customerId: true,
        productId: true,
        productIds: true,
        occurredAt: true,
        validatedAt: true,
        createdAt: true,
        metadata: true,
        adSourceId: true,
        adTitle: true,
        payerName: true,
        payerPhone: true,
        operationCode: true,
        reference: true,
        source: true,
        matchScore: true,
      },
    }),
    prisma.order.findMany({
      where: {
        companyId,
        totalAmount: { not: null },
        status: { not: "CANCELADO" },
        OR: [{ createdAt: range }, { payments: { some: { createdAt: range } } }],
      },
      select: {
        id: true,
        orderCode: true,
        status: true,
        source: true,
        customerId: true,
        productId: true,
        quantity: true,
        totalAmount: true,
        paymentMethod: true,
        createdAt: true,
        items: { select: { productId: true, quantity: true, lineTotal: true } },
        payments: { select: { createdAt: true, method: true, receiptId: true }, orderBy: { createdAt: "asc" } },
      },
    }),
  ]);

  // Comprobantes que pertenecen a un pedido con montos: no son una venta aparte.
  const receiptOrderIds = [...new Set(receipts.map((r) => r.orderId).filter(Boolean) as string[])];
  const moneyOrderIds = new Set(orders.map((o) => o.id));
  const linkedReceiptIds = new Set<string>();
  for (const o of orders) for (const p of o.payments) if (p.receiptId) linkedReceiptIds.add(p.receiptId);
  const missing = receiptOrderIds.filter((id) => !moneyOrderIds.has(id) && /^[0-9a-f-]{36}$/i.test(id));
  if (missing.length) {
    // Pedidos fuera del rango consultado (p. ej. el saldo se pagó semanas después).
    const extra = await prisma.order.findMany({
      where: { companyId, id: { in: missing }, totalAmount: { not: null } },
      select: { id: true },
    });
    for (const o of extra) moneyOrderIds.add(o.id);
  }
  const receiptById = new Map(receipts.map((r) => [r.id, r]));

  // Precio de catálogo: peso para repartir un comprobante con varios productos.
  const multiIds = new Set<string>();
  for (const r of receipts) {
    const ids = new Set<string>(r.productIds ?? []);
    if (r.productId) ids.add(r.productId);
    if (ids.size > 1) for (const id of ids) multiIds.add(id);
  }
  const prices = multiIds.size
    ? await prisma.product.findMany({ where: { companyId, id: { in: [...multiIds] } }, select: { id: true, price: true } })
    : [];
  const priceById = new Map(prices.map((p) => [p.id, parseMoney(p.price)]));

  const sales: Sale[] = [];

  for (const r of receipts) {
    if (linkedReceiptIds.has(r.id) || (r.orderId && moneyOrderIds.has(r.orderId))) continue;
    const at = receiptAt(r);
    if (at < from || at > to) continue;
    const ids = new Set<string>(r.productIds ?? []);
    if (r.productId) ids.add(r.productId);
    const amount = parseMoney(r.amountPaid ?? r.amountExpected);
    sales.push({
      key: `receipt:${r.id}`,
      kind: "receipt",
      at,
      amount,
      customerId: r.customerId,
      shares: splitAmount(amount, [...ids].map((id) => ({ productId: id, weight: priceById.get(id) ?? 0, units: 1 }))),
      paymentSource: r.paymentSource,
      validationMode: r.validationMode,
      adSourceId: r.adSourceId,
      adTitle: r.adTitle,
      channel: ((r.metadata ?? {}) as { channel?: string }).channel === "storefront" ? "store" : "chat",
      payerName: r.payerName,
      payerPhone: r.payerPhone,
      operationCode: r.operationCode,
      reference: r.reference,
      source: r.source,
      matchScore: r.matchScore,
      orderCode: null,
    });
  }

  for (const o of orders) {
    const firstPayment = o.payments[0];
    if (!firstPayment && !CONFIRMED_WITHOUT_PAYMENT.includes(o.status)) continue; // aún no es venta
    const at = firstPayment?.createdAt ?? o.createdAt;
    if (at < from || at > to) continue;
    const amount = parseMoney(Number(o.totalAmount));
    const lines = o.items.length
      ? o.items
          .filter((i) => i.productId)
          .map((i) => ({ productId: i.productId as string, weight: parseMoney(i.lineTotal), units: i.quantity }))
      : [];
    if (!lines.length) lines.push({ productId: o.productId, weight: 1, units: o.quantity });
    const receipt = o.payments.map((p) => (p.receiptId ? receiptById.get(p.receiptId) : undefined)).find(Boolean);
    sales.push({
      key: `order:${o.id}`,
      kind: "order",
      at,
      amount,
      customerId: o.customerId,
      shares: splitAmount(amount, lines),
      paymentSource: firstPayment?.method ?? o.paymentMethod ?? (firstPayment ? null : "contraentrega"),
      validationMode: receipt?.validationMode ?? null,
      adSourceId: receipt?.adSourceId ?? null,
      adTitle: receipt?.adTitle ?? null,
      channel: o.source === "WEB" ? "store" : "chat",
      payerName: receipt?.payerName ?? null,
      payerPhone: receipt?.payerPhone ?? null,
      operationCode: receipt?.operationCode ?? null,
      reference: receipt?.reference ?? null,
      source: receipt?.source ?? "pedido",
      matchScore: receipt?.matchScore ?? null,
      orderCode: o.orderCode,
    });
  }

  return sales.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Monto de la venta: completo, o solo la parte del producto filtrado. */
export function saleAmountFor(sale: Sale, productId?: string | null): number {
  if (!productId) return sale.amount;
  return sale.shares.filter((s) => s.productId === productId).reduce((a, s) => a + s.amount, 0);
}

export function saleUnitsFor(sale: Sale, productId?: string | null): number {
  return sale.shares.filter((s) => !productId || s.productId === productId).reduce((a, s) => a + s.units, 0);
}

export const saleHasProduct = (sale: Sale, productId?: string | null) =>
  !productId || sale.shares.some((s) => s.productId === productId);
