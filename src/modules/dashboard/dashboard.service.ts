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

const inRange = (d: Date, a: Date, b: Date) => d.getTime() >= a.getTime() && d.getTime() <= b.getTime();
const refDate = (r: { occurredAt: Date | null; validatedAt: Date | null; createdAt: Date }) =>
  r.occurredAt ?? r.validatedAt ?? r.createdAt;
const receiptProductIds = (r: { productId: string | null; productIds: string[] }) => {
  const set = new Set<string>(r.productIds ?? []);
  if (r.productId) set.add(r.productId);
  return [...set];
};

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
  const toDayKey = dayKeyFormatter(timezone);

  // ---- Rango actual y periodo anterior equivalente (en la TZ del negocio) ----
  // Los límites se anclan a la medianoche/fin-de-día LOCAL del tenant (no UTC), si
  // no, en zonas UTC- se perdería el día de hoy y las ventas de la tarde/noche.
  const now = new Date();
  const toYmd = params.to ?? toDayKey(now);
  const fromYmd = params.from ?? toDayKey(new Date(now.getTime() - 29 * DAY_MS));
  const toDate = zonedDayBoundary(toYmd, timezone, true);
  const fromDate = zonedDayBoundary(fromYmd, timezone, false);
  const lengthMs = Math.max(DAY_MS, toDate.getTime() - fromDate.getTime());
  const prevTo = new Date(fromDate.getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - lengthMs);
  const days = Math.round(lengthMs / DAY_MS);
  const granularity: "daily" | "monthly" = days <= 92 ? "daily" : "monthly";

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
      customerId: true,
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

  // ---- Embudo / global (todo sensible al rango). Pending y leads convertidos
  // respetan el filtro de producto; contactos y conversaciones quedan globales. ----
  const productClause = productId
    ? { OR: [{ productId }, { productIds: { has: productId } }] }
    : {};
  const [customersWindow, conversationsCur, conversationsPrev, pendingReceipts, remindersCur, remindersPrev, flowsTotal, flowsActive] =
    await Promise.all([
      // Clientes creados en [prevFrom, toDate] (ids para separar actual/anterior y
      // cruzar con quienes cerraron venta).
      prisma.customer.findMany({ where: { companyId, createdAt: { gte: prevFrom, lte: toDate } }, select: { id: true, createdAt: true } }),
      prisma.conversation.count({ where: { companyId, channel: "whatsapp", createdAt: { gte: fromDate, lte: toDate } } }),
      prisma.conversation.count({ where: { companyId, channel: "whatsapp", createdAt: { gte: prevFrom, lte: prevTo } } }),
      prisma.paymentReceipt.count({ where: { companyId, status: { in: ["PENDIENTE", "EN_REVISION"] }, createdAt: { gte: fromDate, lte: toDate }, ...productClause } }),
      prisma.scheduledMessage.count({ where: { companyId, status: "SENT", type: { in: FOLLOWUP_TYPES as any }, sentAt: { gte: fromDate, lte: toDate } } }),
      prisma.scheduledMessage.count({ where: { companyId, status: "SENT", type: { in: FOLLOWUP_TYPES as any }, sentAt: { gte: prevFrom, lte: prevTo } } }),
      prisma.chatFlow.count({ where: { companyId } }),
      prisma.chatFlow.count({ where: { companyId, isActive: true } }),
    ]);

  const newIdsCur = customersWindow.filter((c) => inRange(c.createdAt, fromDate, toDate)).map((c) => c.id);
  const newIdsPrev = customersWindow.filter((c) => inRange(c.createdAt, prevFrom, prevTo)).map((c) => c.id);
  const newContacts: Delta = { value: newIdsCur.length, prev: newIdsPrev.length };
  const conversations: Delta = { value: conversationsCur, prev: conversationsPrev };

  // Conversión global del periodo: ventas (con producto, sin filtro) / conversaciones.
  const globalSalesCur = curAll.length;
  const globalSalesPrev = prevAll.length;
  const conversionRate: Delta = {
    value: conversationsCur > 0 ? pct(globalSalesCur / conversationsCur) : 0,
    prev: conversationsPrev > 0 ? pct(globalSalesPrev / conversationsPrev) : 0,
  };

  // Leads convertidos: contactos NUEVOS del periodo que cerraron una venta (de los
  // comprobantes producto-filtrados del periodo). Respeta rango y producto.
  const salesCustCur = new Set(cur.map((r) => r.customerId).filter(Boolean) as string[]);
  const salesCustPrev = new Set(prev.map((r) => r.customerId).filter(Boolean) as string[]);
  const convertedLeads: Delta = {
    value: newIdsCur.filter((id) => salesCustCur.has(id)).length,
    prev: newIdsPrev.filter((id) => salesCustPrev.has(id)).length,
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
      convertedLeads,
    },
    series,
    topProducts,
    paymentMethods,
    funnel: { contacts: newContacts.value, conversations: conversationsCur, sales: globalSalesCur },
    flows: { total: flowsTotal, active: flowsActive },
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
function zonedDayBoundary(ymd: string, timeZone: string, end: boolean): Date {
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

  const productClause = productId ? { OR: [{ productId }, { productIds: { has: productId } }] } : {};
  const toAmount = (paid: string | null, expected: string) => {
    const a = Number(paid ?? expected);
    return Number.isFinite(a) && a > 0 ? r2(a) : 0;
  };

  const [salesRaw, pendingRaw, customersRaw, remindersRaw, conversationsRaw, productName] = await Promise.all([
    prisma.paymentReceipt.findMany({
      where: {
        companyId,
        status: "APROBADO",
        OR: [{ productId: { not: null } }, { productIds: { isEmpty: false } }],
        AND: [
          {
            OR: [
              { occurredAt: { gte: fromDate, lte: toDate } },
              { validatedAt: { gte: fromDate, lte: toDate } },
              { createdAt: { gte: fromDate, lte: toDate } },
            ],
          },
          productClause,
        ],
      },
      select: {
        amountPaid: true,
        amountExpected: true,
        currency: true,
        paymentSource: true,
        payerName: true,
        payerPhone: true,
        operationCode: true,
        reference: true,
        source: true,
        validationMode: true,
        matchScore: true,
        customerId: true,
        productId: true,
        productIds: true,
        occurredAt: true,
        validatedAt: true,
        createdAt: true,
        customer: { select: { name: true, phone: true } },
        product: { select: { name: true } },
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),
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
    productId
      ? prisma.product
          .findFirst({ where: { id: productId, companyId }, select: { name: true } })
          .then((p) => p?.name ?? null)
      : Promise.resolve(null),
  ]);

  // Mismo criterio que el KPI de ventas: fecha de referencia dentro del rango.
  const salesFiltered = salesRaw
    .filter((r) => inRange(refDate(r), fromDate, toDate))
    .sort((a, b) => refDate(a).getTime() - refDate(b).getTime());

  // Nombres de TODOS los productos referenciados (sales + pending) en una query.
  const allProductIds = new Set<string>();
  for (const r of salesFiltered) for (const id of receiptProductIds(r)) allProductIds.add(id);
  for (const r of pendingRaw) for (const id of receiptProductIds(r)) allProductIds.add(id);
  const prodNames = allProductIds.size
    ? await prisma.product.findMany({ where: { companyId, id: { in: [...allProductIds] } }, select: { id: true, name: true } })
    : [];
  const nameById = new Map(prodNames.map((p) => [p.id, p.name.trim()]));
  const productsLabel = (r: { productId: string | null; productIds: string[] }) =>
    receiptProductIds(r)
      .map((id) => nameById.get(id) ?? "Producto")
      .join(", ");

  const sales = salesFiltered.map((r) => ({
    date: refDate(r),
    customerName: r.customer?.name ?? null,
    customerPhone: r.customer?.phone ?? null,
    payerName: r.payerName,
    payerPhone: r.payerPhone,
    method: r.paymentSource,
    amount: toAmount(r.amountPaid, r.amountExpected),
    currency: r.currency,
    products: productsLabel(r),
    validationMode: r.validationMode,
    operationCode: r.operationCode,
    reference: r.reference,
    source: r.source,
    matchScore: r.matchScore,
  }));

  const salesCustomerIds = new Set(salesFiltered.map((r) => r.customerId).filter(Boolean) as string[]);

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
    purchased: salesCustomerIds.has(c.id),
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
  };
}
