/**
 * Métricas del dashboard del tenant. Todo se calcula sobre un RANGO de fechas (en la
 * zona horaria del negocio) y, opcionalmente, filtrado por producto, comparando contra
 * el periodo anterior equivalente para mostrar la variación (delta).
 *
 * Qué es una venta lo define dashboard-sales.ts (comprobante aprobado, o un pedido con
 * montos contado UNA vez con su total). Las conversiones son de COHORTE: de quienes
 * llegaron en el periodo, cuántos ya compraron (aunque paguen días después); así nunca
 * superan el 100 %.
 */

import { prisma } from "../../lib/prisma";
import { resolveAdCatalog, adCatalogEntryFor } from "../ad-catalog/ad-catalog.service";
import { loadSales, saleAmountFor, saleHasProduct, saleUnitsFor, type Sale } from "./dashboard-sales";
import { daysBetween, resolveRange } from "./dashboard-periods";
import { adKeyOf, buildAdRows, collectAdCohort, countAdLeads, summarizeAds, type AdSaleRow } from "./dashboard-ads";

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
// Holgura al cruzar «llegó» con «compró»: relojes de la pasarela y del chat no coinciden al segundo.
const COHORT_SLACK_MS = 2 * 60 * 1000;

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

const inRange = (d: Date, a: Date, b: Date) => d.getTime() >= a.getTime() && d.getTime() <= b.getTime();
const receiptProductIds = (r: { productId: string | null; productIds: string[] }) => {
  const set = new Set<string>(r.productIds ?? []);
  if (r.productId) set.add(r.productId);
  return [...set];
};

export interface DashboardParams {
  companyId: string;
  period?: string; // today | yesterday | week | last_week | 7d | 30d | month | last_month | 12m
  from?: string; // YYYY-MM-DD
  to?: string; // YYYY-MM-DD
  productId?: string;
}

// Filas especiales de «Por anuncio» (no son anuncios).
export const AD_ROW_STORE = "storefront";
export const AD_ROW_UNLINKED = "unlinked";
const AD_SPECIAL_ROWS = [AD_ROW_STORE, AD_ROW_UNLINKED];

/** Cálculo completo; devuelve además las personas por anuncio para el detalle. */
async function computeDashboard(params: DashboardParams) {
  const { companyId, productId } = params;
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { timezone: true, currency: true },
  });
  const timezone = company?.timezone ?? "America/Lima";
  const currency = (company?.currency ?? "PEN").toUpperCase();
  const toDayKey = dayKeyFormatter(timezone);

  // ---- Rango actual y periodo anterior equivalente (en la TZ del negocio) ----
  // Los límites se anclan a la medianoche/fin-de-día LOCAL del tenant (no UTC), si
  // no, en zonas UTC- se perdería el día de hoy y las ventas de la tarde/noche.
  const now = new Date();
  const range = resolveRange(params, timezone, now);
  const fromDate = zonedDayBoundary(range.from, timezone, false);
  const toDate = zonedDayBoundary(range.to, timezone, true);
  const prevFrom = zonedDayBoundary(range.prevFrom, timezone, false);
  const prevTo = zonedDayBoundary(range.prevTo, timezone, true);
  const days = daysBetween(range.from, range.to);
  const granularity: "daily" | "monthly" = days <= 92 ? "daily" : "monthly";

  // ---- Ventas desde el periodo anterior hasta HOY (un solo fetch). Lo posterior al
  // rango solo se usa para saber si quien llegó en el periodo terminó comprando. ----
  const horizon = toDate.getTime() > now.getTime() ? toDate : now;
  const allSales = await loadSales(companyId, prevFrom, horizon);
  const curAll = allSales.filter((s) => inRange(s.at, fromDate, toDate));
  const prevAll = allSales.filter((s) => inRange(s.at, prevFrom, prevTo));
  const cur = curAll.filter((s) => saleHasProduct(s, productId));
  const prev = prevAll.filter((s) => saleHasProduct(s, productId));

  // ---- KPIs de ventas (respetan el filtro de producto) ----
  const sumRevenue = (rs: Sale[]) => rs.reduce((acc, s) => acc + saleAmountFor(s, productId), 0);
  const sumUnits = (rs: Sale[]) => rs.reduce((acc, s) => acc + saleUnitsFor(s, productId), 0);

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
  for (const s of cur) {
    const m = (s.paymentSource ?? "otro").toLowerCase();
    methodMap.set(m, (methodMap.get(m) ?? 0) + 1);
    if (s.validationMode === "AUTO") autoApprovals += 1;
    else if (s.validationMode === "MANUAL") manualApprovals += 1;
  }
  const paymentMethods = [...methodMap.entries()]
    .map(([method, count]) => ({ method, count }))
    .sort((a, b) => b.count - a.count);

  // Ranking de productos más vendidos (global del periodo, ignora el filtro). Una
  // venta con varios productos reparte su monto entre ellos: la suma cuadra con Ingresos.
  const prodAgg = new Map<string, { revenue: number; units: number }>();
  for (const s of curAll) {
    for (const share of s.shares) {
      const agg = prodAgg.get(share.productId) ?? { revenue: 0, units: 0 };
      agg.revenue += share.amount;
      agg.units += share.units;
      prodAgg.set(share.productId, agg);
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
  const bucket = new Map<string, { total: number; count: number }>();
  for (const s of cur) {
    const a = saleAmountFor(s, productId);
    if (a <= 0) continue;
    const dayKey = toDayKey(s.at);
    const key = granularity === "daily" ? dayKey : dayKey.slice(0, 7);
    const b = bucket.get(key) ?? { total: 0, count: 0 };
    b.total += a;
    b.count += 1;
    bucket.set(key, b);
  }
  const series: SeriesPoint[] = [];
  if (granularity === "daily") {
    for (let i = 0; i < days; i++) {
      // Mediodía local: sumar días en milisegundos no se sale del día aunque cambie la hora.
      const d = new Date(fromDate.getTime() + i * DAY_MS + DAY_MS / 2);
      const key = toDayKey(d);
      const b = bucket.get(key) ?? { total: 0, count: 0 };
      const [, m, day] = key.split("-").map(Number);
      series.push({ date: key, label: `${day} ${MONTH_LABELS[(m ?? 1) - 1]}`, total: r2(b.total), count: b.count });
    }
  } else {
    const startKey = range.from.slice(0, 7);
    const endKey = range.to.slice(0, 7);
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

  // ---- Embudo / global (todo sensible al rango). Por revisar, citas y conversiones
  // respetan el producto; contactos, conversaciones y recordatorios no tienen producto. ----
  const productClause = productId
    ? { OR: [{ productId }, { productIds: { has: productId } }] }
    : {};
  const bookingProduct = productId ? { productId } : {};
  const [
    customersWindow,
    conversationsCur,
    conversationsPrev,
    pendingReceipts,
    remindersCur,
    remindersPrev,
    flowsTotal,
    flowsActive,
    bookingsCur,
    bookingsPrev,
    bookingsUpcoming,
    ordersGrouped,
  ] =
    await Promise.all([
      // Clientes creados en [prevFrom, toDate] (ids para separar actual/anterior y
      // cruzar con quienes cerraron venta).
      prisma.customer.findMany({ where: { companyId, createdAt: { gte: prevFrom, lte: toDate } }, select: { id: true, createdAt: true, adSourceId: true } }),
      prisma.conversation.count({ where: { companyId, channel: "whatsapp", createdAt: { gte: fromDate, lte: toDate } } }),
      prisma.conversation.count({ where: { companyId, channel: "whatsapp", createdAt: { gte: prevFrom, lte: prevTo } } }),
      prisma.paymentReceipt.count({ where: { companyId, status: { in: ["PENDIENTE", "EN_REVISION"] }, createdAt: { gte: fromDate, lte: toDate }, ...productClause } }),
      prisma.scheduledMessage.count({ where: { companyId, status: "SENT", type: { in: FOLLOWUP_TYPES as any }, sentAt: { gte: fromDate, lte: toDate } } }),
      prisma.scheduledMessage.count({ where: { companyId, status: "SENT", type: { in: FOLLOWUP_TYPES as any }, sentAt: { gte: prevFrom, lte: prevTo } } }),
      prisma.chatFlow.count({ where: { companyId } }),
      prisma.chatFlow.count({ where: { companyId, isActive: true } }),
      // Citas agendadas en el periodo (rubro servicios) y las que vienen en 24 h.
      prisma.serviceBooking.count({
        where: { companyId, createdAt: { gte: fromDate, lte: toDate }, status: { not: "CANCELADA" }, ...bookingProduct },
      }),
      prisma.serviceBooking.count({
        where: { companyId, createdAt: { gte: prevFrom, lte: prevTo }, status: { not: "CANCELADA" }, ...bookingProduct },
      }),
      prisma.serviceBooking.count({
        where: {
          companyId,
          startsAt: { gte: now, lte: new Date(now.getTime() + DAY_MS) },
          status: { in: ["SOLICITADA", "CONFIRMADA"] },
          ...bookingProduct,
        },
      }),
      // Pedidos registrados en el periodo, por estado (pestaña «Pagos y entregas»).
      prisma.order.groupBy({
        by: ["status"],
        where: { companyId, createdAt: { gte: fromDate, lte: toDate }, ...(productId ? { OR: [{ productId }, { items: { some: { productId } } }] } : {}) },
        _count: { _all: true },
      }),
    ]);

  const newCur = customersWindow.filter((c) => inRange(c.createdAt, fromDate, toDate));
  const newPrev = customersWindow.filter((c) => inRange(c.createdAt, prevFrom, prevTo));
  const newContacts: Delta = { value: newCur.length, prev: newPrev.length };
  const conversations: Delta = { value: conversationsCur, prev: conversationsPrev };

  // ---- Cohorte: ¿esta persona compró DESPUÉS de llegar? Se mira su última venta (del
  // producto filtrado, si hay filtro) hasta hoy. ----
  const lastSaleAt = new Map<string, number>();
  for (const s of allSales) {
    if (!s.customerId || !saleHasProduct(s, productId)) continue;
    const t = s.at.getTime();
    if (t > (lastSaleAt.get(s.customerId) ?? 0)) lastSaleAt.set(s.customerId, t);
  }
  const boughtSince = (customerId: string, since: Date) =>
    (lastSaleAt.get(customerId) ?? 0) >= since.getTime() - COHORT_SLACK_MS;

  // Leads que compraron: contactos NUEVOS del periodo que ya cerraron una venta.
  const convertedLeads: Delta = {
    value: newCur.filter((c) => boughtSince(c.id, c.createdAt)).length,
    prev: newPrev.filter((c) => boughtSince(c.id, c.createdAt)).length,
  };
  // Tasa de conversión: de los contactos nuevos, qué porcentaje ya compró.
  const conversionRate: Delta = {
    value: newContacts.value > 0 ? pct(convertedLeads.value / newContacts.value) : 0,
    prev: newContacts.prev > 0 ? pct(convertedLeads.prev / newContacts.prev) : 0,
  };

  // ---- Rendimiento por anuncio (atribución CTWA) ----
  // Leads: personas que escribieron desde cada anuncio en el periodo (clics en AdTouch).
  // Compraron: de esos leads, cuántos ya compraron después de su clic (cohorte).
  // Ventas / ingresos: ventas DEL PERIODO por el anuncio vigente al momento de vender.
  // Con filtro de producto: solo anuncios cuyo producto del catálogo es ese, y solo
  // ventas de ese producto.
  const adCatalog = await resolveAdCatalog(companyId);
  // Clics del periodo y del periodo anterior (este último solo para comparar leads).
  const touchSelect = { customerId: true, adSourceId: true, adTitle: true, createdAt: true } as const;
  const [periodTouchesRaw, prevTouchesRaw] = await Promise.all([
    prisma.adTouch.findMany({
      where: { companyId, createdAt: { gte: fromDate, lte: toDate } },
      orderBy: { createdAt: "asc" },
      select: touchSelect,
    }),
    prisma.adTouch.findMany({
      where: { companyId, createdAt: { gte: prevFrom, lte: prevTo } },
      select: touchSelect,
    }),
  ]);
  const touchOfProduct = (t: { adSourceId: string | null; adTitle: string | null }) =>
    !productId || adCatalogEntryFor(adCatalog, t.adSourceId, t.adTitle)?.productId === productId;
  const periodTouches = periodTouchesRaw.filter(touchOfProduct);
  const prevTouches = prevTouchesRaw.filter(touchOfProduct);

  // Anuncio de cada venta del periodo: el guardado en la venta; si no lo tiene, el
  // último clic de esa persona anterior a la venta.
  const saleCustomerIds = [...new Set(cur.filter((s) => !s.adSourceId && s.customerId).map((s) => s.customerId as string))];
  const saleTouches = saleCustomerIds.length
    ? await prisma.adTouch.findMany({
        where: { companyId, customerId: { in: saleCustomerIds }, createdAt: { lte: toDate } },
        orderBy: { createdAt: "asc" },
        select: { customerId: true, adSourceId: true, adTitle: true, createdAt: true },
      })
    : [];
  const touchesByCustomer = new Map<string, typeof saleTouches>();
  for (const t of saleTouches) {
    const list = touchesByCustomer.get(t.customerId) ?? [];
    list.push(t);
    touchesByCustomer.set(t.customerId, list);
  }
  const adOfSale = (s: Sale): { adSourceId: string | null; adTitle: string | null } => {
    if (s.adSourceId) return { adSourceId: s.adSourceId, adTitle: s.adTitle };
    const list = s.customerId ? touchesByCustomer.get(s.customerId) : undefined;
    if (!list) return { adSourceId: null, adTitle: null };
    const limit = s.at.getTime() + COHORT_SLACK_MS;
    let found: (typeof saleTouches)[number] | null = null;
    for (const t of list) {
      if (t.createdAt.getTime() > limit) break;
      found = t;
    }
    return { adSourceId: found?.adSourceId ?? null, adTitle: found?.adTitle ?? null };
  };
  const periodSales: AdSaleRow[] = cur.map((s) => {
    const base = { key: s.key, customerId: s.customerId, at: s.at, amount: saleAmountFor(s, productId) };
    if (s.channel === "store") return { ...base, adSourceId: AD_ROW_STORE, adTitle: "Tienda web" };
    const ad = adOfSale(s);
    // Pago aprobado sin cliente asociado: fila propia (no es «orgánico»).
    if (!ad.adSourceId && !s.customerId) return { ...base, adSourceId: AD_ROW_UNLINKED, adTitle: "Pagos sin cliente" };
    return { ...base, adSourceId: ad.adSourceId, adTitle: ad.adTitle };
  });
  // Compras de cada persona (del producto filtrado, si hay filtro), en orden de fecha.
  const purchasesByCustomer = new Map<string, Array<{ at: number; amount: number }>>();
  for (const s of allSales) {
    if (!s.customerId || !saleHasProduct(s, productId)) continue;
    const list = purchasesByCustomer.get(s.customerId) ?? [];
    list.push({ at: s.at.getTime(), amount: saleAmountFor(s, productId) });
    purchasesByCustomer.set(s.customerId, list);
  }
  for (const list of purchasesByCustomer.values()) list.sort((a, b) => a.at - b.at);

  const adBuckets = collectAdCohort({
    touches: periodTouches,
    newContacts: newCur,
    periodSales,
    purchasesByCustomer,
    slackMs: COHORT_SLACK_MS,
  });
  const adPerformance = buildAdRows(adBuckets, (adSourceId, adTitle) =>
    adSourceId && !AD_SPECIAL_ROWS.includes(adSourceId) ? adCatalogEntryFor(adCatalog, adSourceId, adTitle) : null,
  );
  // Resumen de los anuncios: lo que se lee de un vistazo arriba de la pestaña.
  const adSummary = summarizeAds(adPerformance, adBuckets, { leadsPrev: countAdLeads(prevTouches), specialKeys: AD_SPECIAL_ROWS });

  const stats = {
    range: { from: range.from, to: range.to, prevFrom: range.prevFrom, prevTo: range.prevTo, period: params.period ?? null, granularity },
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
      convertedLeads,
      bookings: { value: bookingsCur, prev: bookingsPrev },
      upcomingBookings: bookingsUpcoming,
    },
    series,
    topProducts,
    paymentMethods,
    adPerformance,
    adSummary,
    // Embudo de cohorte: contactos nuevos → conversaciones abiertas → cuántos ya compraron.
    funnel: { contacts: newContacts.value, conversations: conversationsCur, sales: convertedLeads.value },
    flows: { total: flowsTotal, active: flowsActive },
    ordersByStatus: ordersGrouped.map((g) => ({ status: g.status as string, count: g._count._all })),
  };
  return { stats, adBuckets, timezone, fromDate };
}

export async function getDashboardStats(params: DashboardParams) {
  return (await computeDashboard(params)).stats;
}

const AD_LEADS_CAP = 300;

/**
 * Personas detrás de una fila de «Por anuncio»: quién escribió en el periodo y si ya
 * compró, y quién pagó en el periodo habiendo escrito antes. Misma cuenta que la tabla
 * (sale del mismo cálculo). `adSourceId` «none» = sin anuncio (orgánico).
 */
export async function getAdLeads(params: DashboardParams & { adSourceId: string }) {
  const { companyId } = params;
  const { stats, adBuckets, fromDate, timezone } = await computeDashboard(params);
  const adSourceId = params.adSourceId === "none" ? null : params.adSourceId;
  const bucket = adBuckets.get(adKeyOf(adSourceId));
  const row = stats.adPerformance.find((r) => r.adSourceId === adSourceId) ?? null;
  const people = bucket ? [...bucket.people.values()].sort((a, b) => b.wroteAt.getTime() - a.wroteAt.getTime()) : [];
  const earlier = bucket ? [...bucket.earlier].sort((a, b) => b.at.getTime() - a.at.getTime()) : [];
  const shownPeople = people.slice(0, AD_LEADS_CAP);
  const shownEarlier = earlier.slice(0, AD_LEADS_CAP);

  const ids = [...new Set([...shownPeople.map((p) => p.customerId), ...shownEarlier.map((e) => e.customerId).filter((x): x is string => !!x)])];
  const earlierIds = [...new Set(shownEarlier.map((e) => e.customerId).filter((x): x is string => !!x))];
  const [customers, conversations, earlierTouches] = await Promise.all([
    ids.length
      ? prisma.customer.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, name: true, phone: true, createdAt: true } })
      : [],
    ids.length
      ? prisma.conversation.findMany({
          where: { companyId, customerId: { in: ids } },
          orderBy: { updatedAt: "desc" },
          select: { id: true, customerId: true },
        })
      : [],
    // Cuándo escribió (antes del periodo) quien pagó en el periodo: su último clic previo.
    earlierIds.length && adSourceId
      ? prisma.adTouch.findMany({
          where: { companyId, customerId: { in: earlierIds }, adSourceId, createdAt: { lt: fromDate } },
          orderBy: { createdAt: "asc" },
          select: { customerId: true, createdAt: true },
        })
      : [],
  ]);
  const customerById = new Map(customers.map((c) => [c.id, c]));
  const conversationOf = new Map<string, string>();
  for (const c of conversations) if (!conversationOf.has(c.customerId)) conversationOf.set(c.customerId, c.id);
  const lastTouchBefore = new Map<string, Date>();
  for (const t of earlierTouches) lastTouchBefore.set(t.customerId, t.createdAt);
  const who = (customerId: string | null) => {
    const c = customerId ? customerById.get(customerId) : undefined;
    return {
      customerId,
      name: c?.name?.trim() || null,
      phone: c?.phone ?? null,
      conversationId: customerId ? conversationOf.get(customerId) ?? null : null,
    };
  };

  return {
    range: stats.range,
    currency: stats.currency,
    timezone,
    ad: row,
    people: shownPeople.map((p) => ({
      ...who(p.customerId),
      wroteAt: p.wroteAt.toISOString(),
      isReturning: p.isReturning,
      bought: !!p.boughtAt,
      boughtAt: p.boughtAt?.toISOString() ?? null,
      amount: p.amount,
      hoursToBuy: p.hoursToBuy,
    })),
    earlierBuyers: shownEarlier.map((e) => {
      const wrote = e.customerId ? lastTouchBefore.get(e.customerId) ?? customerById.get(e.customerId)?.createdAt ?? null : null;
      return { ...who(e.customerId), wroteAt: wrote ? wrote.toISOString() : null, boughtAt: e.at.toISOString(), amount: e.amount };
    }),
    totals: { people: people.length, earlierBuyers: earlier.length, cap: AD_LEADS_CAP },
  };
}

/** Offset (ms) entre la hora local del tenant y UTC para esa fecha (sin lib de fechas). */
function tzOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value])) as Record<string, string>;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - date.getTime();
}

/** Instante UTC del inicio (00:00) o fin (23:59:59.999) del día local `ymd` en la TZ del tenant. */
export function zonedDayBoundary(ymd: string, timeZone: string, end: boolean): Date {
  const base = new Date(`${ymd}T${end ? "23:59:59.999" : "00:00:00.000"}Z`);
  const offset = tzOffsetMs(base, timeZone);
  return new Date(base.getTime() - offset);
}

/**
 * Datos completos para el export a Excel del dashboard: los mismos stats de
 * getDashboardStats (cifras idénticas a las tarjetas) + detalle fila a fila del
 * periodo ACTUAL (ventas, comprobantes por revisar, clientes nuevos, recordatorios
 * y conversaciones). El .xlsx lo arma el frontend (ExcelJS).
 */
const EXPORT_ROW_CAP = 10000;

export async function getDashboardExportData(params: DashboardParams) {
  const { companyId, productId } = params;
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { name: true, timezone: true },
  });
  const timezone = company?.timezone ?? "America/Lima";

  const stats = await getDashboardStats(params);
  const fromDate = zonedDayBoundary(stats.range.from, timezone, false);
  const toDate = zonedDayBoundary(stats.range.to, timezone, true);
  // Fechas ya resueltas: el detalle usa exactamente el mismo rango que las tarjetas.
  const now = new Date();
  const horizon = toDate.getTime() > now.getTime() ? toDate : now;

  const productClause = productId ? { OR: [{ productId }, { productIds: { has: productId } }] } : {};
  const toAmount = (paid: string | null, expected: string) => {
    const a = Number(paid ?? expected);
    return Number.isFinite(a) && a > 0 ? r2(a) : 0;
  };

  const [salesAll, pendingRaw, customersRaw, remindersRaw, conversationsRaw, bookingsRaw, productName] =
    await Promise.all([
    // Mismo lector que las tarjetas (un pedido = una venta). Hasta hoy, para saber
    // qué clientes nuevos terminaron comprando.
    loadSales(companyId, fromDate, horizon),
    prisma.paymentReceipt.findMany({
      where: {
        companyId,
        status: { in: ["PENDIENTE", "EN_REVISION"] },
        createdAt: { gte: fromDate, lte: toDate },
        ...productClause,
      },
      select: {
        status: true,
        amountPaid: true,
        amountExpected: true,
        currency: true,
        paymentSource: true,
        payerName: true,
        source: true,
        productId: true,
        productIds: true,
        createdAt: true,
        customer: { select: { name: true, phone: true } },
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),
    prisma.customer.findMany({
      where: { companyId, createdAt: { gte: fromDate, lte: toDate } },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        origenDeLead: true,
        createdAt: true,
        selectedProduct: { select: { name: true } },
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),
    prisma.scheduledMessage.findMany({
      where: { companyId, status: "SENT", type: { in: FOLLOWUP_TYPES as any }, sentAt: { gte: fromDate, lte: toDate } },
      select: { type: true, sentAt: true, body: true, customer: { select: { name: true, phone: true } } },
      orderBy: { sentAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),
    prisma.conversation.findMany({
      where: { companyId, channel: "whatsapp", createdAt: { gte: fromDate, lte: toDate } },
      select: {
        createdAt: true,
        status: true,
        botPaused: true,
        lastMessageAt: true,
        closedAt: true,
        customer: { select: { name: true, phone: true } },
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),
    // Citas del periodo (rubro servicios): se exportan por fecha de creación.
    prisma.serviceBooking.findMany({
      where: { companyId, createdAt: { gte: fromDate, lte: toDate }, ...(productId ? { productId } : {}) },
      select: {
        createdAt: true,
        startsAt: true,
        durationMin: true,
        status: true,
        source: true,
        bookingCode: true,
        requestedText: true,
        customer: { select: { name: true, phone: true } },
        product: { select: { name: true } },
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),
    productId
      ? prisma.product
          .findFirst({ where: { id: productId, companyId }, select: { name: true } })
          .then((p) => p?.name ?? null)
      : Promise.resolve(null),
  ]);

  // Mismo criterio que el KPI de ventas: fecha dentro del rango y producto filtrado.
  const salesOfProduct = salesAll.filter((s) => saleHasProduct(s, productId));
  const salesFiltered = salesOfProduct.filter((s) => inRange(s.at, fromDate, toDate)).slice(0, EXPORT_ROW_CAP);

  // Nombres de TODOS los productos referenciados (sales + pending) y clientes de las ventas.
  const allProductIds = new Set<string>();
  for (const s of salesFiltered) for (const share of s.shares) allProductIds.add(share.productId);
  for (const r of pendingRaw) for (const id of receiptProductIds(r)) allProductIds.add(id);
  const saleCustomerIdList = [...new Set(salesFiltered.map((s) => s.customerId).filter(Boolean) as string[])];
  const [prodNames, saleCustomers] = await Promise.all([
    allProductIds.size
      ? prisma.product.findMany({ where: { companyId, id: { in: [...allProductIds] } }, select: { id: true, name: true } })
      : Promise.resolve([]),
    saleCustomerIdList.length
      ? prisma.customer.findMany({ where: { companyId, id: { in: saleCustomerIdList } }, select: { id: true, name: true, phone: true } })
      : Promise.resolve([]),
  ]);
  const nameById = new Map(prodNames.map((p) => [p.id, p.name.trim()]));
  const customerById = new Map(saleCustomers.map((c) => [c.id, c]));
  const productsLabel = (r: { productId: string | null; productIds: string[] }) =>
    receiptProductIds(r)
      .map((id) => nameById.get(id) ?? "Producto")
      .join(", ");

  const sales = salesFiltered.map((s) => {
    const customer = s.customerId ? customerById.get(s.customerId) : undefined;
    return {
      date: s.at,
      customerName: customer?.name ?? null,
      customerPhone: customer?.phone ?? null,
      payerName: s.payerName,
      payerPhone: s.payerPhone,
      method: s.paymentSource,
      amount: r2(saleAmountFor(s, productId)),
      currency: stats.currency,
      products: s.shares.map((share) => nameById.get(share.productId) ?? "Producto").join(", "),
      validationMode: s.validationMode,
      operationCode: s.operationCode,
      // Un pedido se identifica por su código; un comprobante, por su referencia.
      reference: s.orderCode ?? s.reference,
      source: s.source,
      matchScore: s.matchScore,
    };
  });

  // Clientes nuevos que ya compraron (misma regla de cohorte que las tarjetas).
  const lastSaleAt = new Map<string, number>();
  for (const s of salesOfProduct) {
    if (!s.customerId) continue;
    const t = s.at.getTime();
    if (t > (lastSaleAt.get(s.customerId) ?? 0)) lastSaleAt.set(s.customerId, t);
  }

  const pending = pendingRaw.map((r) => ({
    date: r.createdAt,
    status: r.status,
    customerName: r.customer?.name ?? null,
    customerPhone: r.customer?.phone ?? null,
    payerName: r.payerName,
    amountExpected: toAmount(r.amountPaid, r.amountExpected),
    currency: r.currency,
    method: r.paymentSource,
    source: r.source,
    products: productsLabel(r),
  }));

  const newCustomers = customersRaw.map((c) => ({
    date: c.createdAt,
    name: c.name,
    phone: c.phone,
    email: c.email,
    leadSource: c.origenDeLead,
    interestedIn: c.selectedProduct?.name ?? null,
    purchased: (lastSaleAt.get(c.id) ?? 0) >= c.createdAt.getTime() - COHORT_SLACK_MS,
  }));

  const reminders = remindersRaw.map((m) => ({
    sentAt: m.sentAt,
    type: m.type,
    customerName: m.customer?.name ?? null,
    customerPhone: m.customer?.phone ?? null,
    body: m.body,
  }));

  const conversations = conversationsRaw.map((c) => ({
    createdAt: c.createdAt,
    customerName: c.customer?.name ?? null,
    customerPhone: c.customer?.phone ?? null,
    status: c.status,
    botPaused: c.botPaused,
    lastMessageAt: c.lastMessageAt,
    closedAt: c.closedAt,
  }));

  return {
    stats,
    meta: {
      generatedAt: new Date().toISOString(),
      timezone,
      companyName: company?.name ?? "Mi negocio",
      productName,
    },
    sales,
    pending,
    newCustomers,
    reminders,
    conversations,
    bookings: bookingsRaw.map((b) => ({
      date: b.createdAt,
      startsAt: b.startsAt,
      durationMin: b.durationMin,
      status: b.status,
      source: b.source,
      code: b.bookingCode,
      service: b.product?.name ?? null,
      customerName: b.customer?.name ?? null,
      customerPhone: b.customer?.phone ?? null,
      requestedText: b.requestedText,
    })),
  };
}
