/**
 * Métricas del dashboard del tenant (rubro INFOPRODUCT). Todo se calcula sobre un
 * RANGO de fechas [from, to] y, opcionalmente, filtrado por producto, comparando
 * contra el periodo anterior equivalente para mostrar la variación (delta).
 *
 * Los montos de PaymentReceipt son String legacy → se suman en JS con Number().
 * Una venta = comprobante APROBADO asociado a un producto (productId o productIds).
 * Fecha de referencia de la venta: occurredAt ?? validatedAt ?? createdAt.
 */

import { prisma } from "../../lib/prisma";

interface SeriesPoint {
  date: string; // "2026-06-12" (día) o "2026-06" (mes)
  label: string;
  total: number;
  count: number;
}

interface Delta {
  value: number;
  prev: number;
}

const MONTH_LABELS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const FOLLOWUP_TYPES = ["ABANDONED_CART", "LEFT_ON_READ", "OFFER_COUNTDOWN", "POST_SALE", "CUSTOM"];
const DAY_MS = 24 * 60 * 60 * 1000;

function dayKeyFormatter(timezone: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return (d: Date) => fmt.format(d); // YYYY-MM-DD
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (n: number) => Math.round(n * 10000) / 100; // fracción → %

export interface DashboardParams {
  companyId: string;
  from?: string; // YYYY-MM-DD
  to?: string; // YYYY-MM-DD
  productId?: string;
}

export async function getDashboardStats(params: DashboardParams) {
  const { companyId, productId } = params;
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { timezone: true },
  });
  const timezone = company?.timezone ?? "America/Lima";

  // ---- Rango actual y periodo anterior equivalente ----
  const now = new Date();
  const toDate = params.to ? new Date(`${params.to}T23:59:59.999Z`) : endOfDay(now);
  const fromDate = params.from ? new Date(`${params.from}T00:00:00.000Z`) : new Date(endOfDay(now).getTime() - 30 * DAY_MS + 1);
  const lengthMs = Math.max(DAY_MS, toDate.getTime() - fromDate.getTime());
  const prevTo = new Date(fromDate.getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - lengthMs);
  const days = Math.round(lengthMs / DAY_MS);
  const granularity: "daily" | "monthly" = days <= 92 ? "daily" : "monthly";

  const inRange = (d: Date, a: Date, b: Date) => d.getTime() >= a.getTime() && d.getTime() <= b.getTime();
  const refDate = (r: { occurredAt: Date | null; validatedAt: Date | null; createdAt: Date }) =>
    r.occurredAt ?? r.validatedAt ?? r.createdAt;
  const receiptProductIds = (r: { productId: string | null; productIds: string[] }) => {
    const set = new Set<string>(r.productIds ?? []);
    if (r.productId) set.add(r.productId);
    return [...set];
  };

  // ---- Comprobantes APROBADOS con producto, en [prevFrom, toDate] (un solo fetch) ----
  const receipts = await prisma.paymentReceipt.findMany({
    where: {
      companyId,
      status: "APROBADO",
      OR: [{ productId: { not: null } }, { productIds: { isEmpty: false } }],
      AND: [
        {
          OR: [
            { occurredAt: { gte: prevFrom, lte: toDate } },
            { validatedAt: { gte: prevFrom, lte: toDate } },
            { createdAt: { gte: prevFrom, lte: toDate } },
          ],
        },
      ],
    },
    select: {
      amountPaid: true,
      amountExpected: true,
      currency: true,
      paymentSource: true,
      validationMode: true,
      productId: true,
      productIds: true,
      occurredAt: true,
      validatedAt: true,
      createdAt: true,
    },
  });

  let currency = "PEN";
  const curAll: typeof receipts = [];
  const prevAll: typeof receipts = [];
  for (const r of receipts) {
    if (r.currency) currency = r.currency;
    const when = refDate(r);
    if (inRange(when, fromDate, toDate)) curAll.push(r);
    else if (inRange(when, prevFrom, prevTo)) prevAll.push(r);
  }

  const matchesProduct = (r: { productId: string | null; productIds: string[] }) =>
    !productId || receiptProductIds(r).includes(productId);
  const cur = curAll.filter(matchesProduct);
  const prev = prevAll.filter(matchesProduct);

  // ---- KPIs de ventas (respetan el filtro de producto) ----
  const sumRevenue = (rs: typeof receipts) =>
    rs.reduce((acc, r) => {
      const a = Number(r.amountPaid ?? r.amountExpected);
      return acc + (Number.isFinite(a) && a > 0 ? a : 0);
    }, 0);
  const sumUnits = (rs: typeof receipts) =>
    rs.reduce((acc, r) => {
      const ids = receiptProductIds(r);
      return acc + (productId ? (ids.includes(productId) ? 1 : 0) : ids.length);
    }, 0);

  const revenue: Delta = { value: r2(sumRevenue(cur)), prev: r2(sumRevenue(prev)) };
  const sales: Delta = { value: cur.length, prev: prev.length };
  const units: Delta = { value: sumUnits(cur), prev: sumUnits(prev) };
  const avgTicket: Delta = {
    value: sales.value > 0 ? r2(revenue.value / sales.value) : 0,
    prev: sales.prev > 0 ? r2(revenue.prev / sales.prev) : 0,
  };

  // Métodos de pago y modo de validación (del periodo actual, producto-filtrado)
  const methodMap = new Map<string, number>();
  let autoApprovals = 0;
  let manualApprovals = 0;
  for (const r of cur) {
    const m = (r.paymentSource ?? "otro").toLowerCase();
    methodMap.set(m, (methodMap.get(m) ?? 0) + 1);
    if (r.validationMode === "AUTO") autoApprovals += 1;
    else if (r.validationMode === "MANUAL") manualApprovals += 1;
  }
  const paymentMethods = [...methodMap.entries()]
    .map(([method, count]) => ({ method, count }))
    .sort((a, b) => b.count - a.count);

  // Ranking de productos más vendidos (global del periodo, ignora el filtro)
  const prodAgg = new Map<string, { revenue: number; units: number }>();
  for (const r of curAll) {
    const a = Number(r.amountPaid ?? r.amountExpected);
    const amount = Number.isFinite(a) && a > 0 ? a : 0;
    for (const id of receiptProductIds(r)) {
      const agg = prodAgg.get(id) ?? { revenue: 0, units: 0 };
      agg.revenue += amount;
      agg.units += 1;
      prodAgg.set(id, agg);
    }
  }
  const prodNames = await prisma.product.findMany({
    where: { companyId, id: { in: [...prodAgg.keys()] } },
    select: { id: true, name: true },
  });
  const nameById = new Map(prodNames.map((p) => [p.id, p.name.trim()]));
  const topProducts = [...prodAgg.entries()]
    .map(([id, agg]) => ({ productId: id, name: nameById.get(id) ?? "Producto", revenue: r2(agg.revenue), units: agg.units }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 8);

  // ---- Serie de ingresos en el tiempo (producto-filtrado) ----
  const toDayKey = dayKeyFormatter(timezone);
  const bucket = new Map<string, { total: number; count: number }>();
  for (const r of cur) {
    const a = Number(r.amountPaid ?? r.amountExpected);
    if (!Number.isFinite(a) || a <= 0) continue;
    const dayKey = toDayKey(refDate(r));
    const key = granularity === "daily" ? dayKey : dayKey.slice(0, 7);
    const b = bucket.get(key) ?? { total: 0, count: 0 };
    b.total += a;
    b.count += 1;
    bucket.set(key, b);
  }
  const series: SeriesPoint[] = [];
  if (granularity === "daily") {
    for (let i = 0; i < days; i++) {
      const d = new Date(fromDate.getTime() + i * DAY_MS);
      const key = toDayKey(d);
      const b = bucket.get(key) ?? { total: 0, count: 0 };
      const [, m, day] = key.split("-").map(Number);
      series.push({ date: key, label: `${day} ${MONTH_LABELS[(m ?? 1) - 1]}`, total: r2(b.total), count: b.count });
    }
  } else {
    const startKey = toDayKey(fromDate).slice(0, 7);
    const endKey = toDayKey(toDate).slice(0, 7);
    let [yy, mm] = startKey.split("-").map(Number);
    while (true) {
      const key = `${yy}-${String(mm).padStart(2, "0")}`;
      const b = bucket.get(key) ?? { total: 0, count: 0 };
      series.push({ date: key, label: `${MONTH_LABELS[(mm ?? 1) - 1]} ${String(yy).slice(2)}`, total: r2(b.total), count: b.count });
      if (key === endKey) break;
      mm += 1;
      if (mm === 13) { mm = 1; yy += 1; }
      if (series.length > 240) break; // guard
    }
  }

  // ---- Embudo / global (NO filtra por producto) ----
  const [newContactsCur, newContactsPrev, conversationsCur, conversationsPrev, pendingReceipts, remindersCur, remindersPrev, crmCardsTotal, flowsTotal, flowsActive] =
    await Promise.all([
      prisma.customer.count({ where: { companyId, createdAt: { gte: fromDate, lte: toDate } } }),
      prisma.customer.count({ where: { companyId, createdAt: { gte: prevFrom, lte: prevTo } } }),
      prisma.conversation.count({ where: { companyId, channel: "whatsapp", createdAt: { gte: fromDate, lte: toDate } } }),
      prisma.conversation.count({ where: { companyId, channel: "whatsapp", createdAt: { gte: prevFrom, lte: prevTo } } }),
      prisma.paymentReceipt.count({ where: { companyId, status: { in: ["PENDIENTE", "EN_REVISION"] } } }),
      prisma.scheduledMessage.count({ where: { companyId, status: "SENT", type: { in: FOLLOWUP_TYPES as any }, sentAt: { gte: fromDate, lte: toDate } } }),
      prisma.scheduledMessage.count({ where: { companyId, status: "SENT", type: { in: FOLLOWUP_TYPES as any }, sentAt: { gte: prevFrom, lte: prevTo } } }),
      prisma.crmCard.count({ where: { crm: { companyId } } }),
      prisma.chatFlow.count({ where: { companyId } }),
      prisma.chatFlow.count({ where: { companyId, isActive: true } }),
    ]);

  const newContacts: Delta = { value: newContactsCur, prev: newContactsPrev };
  const conversations: Delta = { value: conversationsCur, prev: conversationsPrev };
  // Conversión global del periodo: ventas (con producto, sin filtro) / conversaciones.
  const globalSalesCur = curAll.length;
  const globalSalesPrev = prevAll.length;
  const conversionRate: Delta = {
    value: conversationsCur > 0 ? pct(globalSalesCur / conversationsCur) : 0,
    prev: conversationsPrev > 0 ? pct(globalSalesPrev / conversationsPrev) : 0,
  };

  return {
    range: { from: toDayKey(fromDate), to: toDayKey(toDate), granularity },
    currency,
    productId: productId ?? null,
    kpis: {
      revenue,
      sales,
      avgTicket,
      units,
      newContacts,
      conversations,
      conversionRate,
      autoApprovals,
      manualApprovals,
      pendingReceipts,
      remindersSent: { value: remindersCur, prev: remindersPrev },
      crmCardsTotal,
    },
    series,
    topProducts,
    paymentMethods,
    funnel: { contacts: newContactsCur, conversations: conversationsCur, sales: globalSalesCur },
    flows: { total: flowsTotal, active: flowsActive },
  };
}

function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(23, 59, 59, 999);
  return x;
}
