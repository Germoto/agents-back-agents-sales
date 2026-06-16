/**
 * Métricas del dashboard del tenant: indicadores de flujos de chatbot y serie
 * de pagos (solo comprobantes APROBADOS asociados a un producto), agrupada por
 * día (últimos 30 días) y por mes (últimos 12 meses) en la zona horaria del
 * negocio. Los montos de PaymentReceipt son String legacy → se suman en JS.
 */

import { prisma } from "../../lib/prisma";

interface SeriesPoint {
  date: string; // "2026-06-12" (día) o "2026-06" (mes)
  label: string;
  total: number;
  count: number;
}

function dayKeyFormatter(timezone: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return (d: Date) => fmt.format(d); // YYYY-MM-DD
}

const MONTH_LABELS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

export async function getDashboardStats(companyId: string) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { timezone: true },
  });
  const timezone = company?.timezone ?? "America/Lima";

  // ---- Indicadores de flujos ----
  const [flowsTotal, flowsActive, activeFlowSessions] = await Promise.all([
    prisma.chatFlow.count({ where: { companyId } }),
    prisma.chatFlow.count({ where: { companyId, isActive: true } }),
    // Conversaciones con una sesión de flujo esperando respuesta del cliente
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM "Conversation"
      WHERE "companyId" = ${companyId}::uuid
        AND "channel" = 'whatsapp'
        AND state -> 'flow' ->> 'awaitingNodeId' IS NOT NULL
    `.then((rows) => Number(rows[0]?.count ?? 0)),
  ]);

  // ---- Indicadores adicionales (rubro infoproducto) ----
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [
    customersTotal,
    customersNewThisMonth,
    conversationsTotal,
    approvedWithProduct,
    paymentMethodGroups,
    validationModeGroups,
    digitalSalesTotal,
    digitalSalesDelivered,
  ] = await Promise.all([
    prisma.customer.count({ where: { companyId } }),
    prisma.customer.count({ where: { companyId, createdAt: { gte: monthStart } } }),
    prisma.conversation.count({ where: { companyId, channel: "whatsapp" } }),
    prisma.paymentReceipt.count({
      where: {
        companyId,
        status: "APROBADO",
        OR: [{ productId: { not: null } }, { productIds: { isEmpty: false } }],
      },
    }),
    prisma.paymentReceipt.groupBy({
      by: ["paymentSource"],
      where: { companyId, status: "APROBADO" },
      _count: { _all: true },
    }),
    prisma.paymentReceipt.groupBy({
      by: ["validationMode"],
      where: { companyId, status: "APROBADO" },
      _count: { _all: true },
    }),
    prisma.digitalSale.count({ where: { companyId } }),
    prisma.digitalSale.count({ where: { companyId, status: "ENTREGADO" } }),
  ]);

  const paymentMethods = paymentMethodGroups
    .map((g) => ({ method: g.paymentSource ?? "otro", count: g._count._all }))
    .sort((a, b) => b.count - a.count);
  const autoApprovals = validationModeGroups.find((g) => g.validationMode === "AUTO")?._count._all ?? 0;
  const manualApprovals = validationModeGroups.find((g) => g.validationMode === "MANUAL")?._count._all ?? 0;
  const conversionRate = conversationsTotal > 0 ? approvedWithProduct / conversationsTotal : 0;
  const deliveryRate = digitalSalesTotal > 0 ? digitalSalesDelivered / digitalSalesTotal : 0;

  // ---- Pagos: APROBADOS y asociados a un producto ----
  const since = new Date();
  since.setMonth(since.getMonth() - 12);
  const receipts = await prisma.paymentReceipt.findMany({
    where: {
      companyId,
      status: "APROBADO",
      createdAt: { gte: since },
      OR: [{ productId: { not: null } }, { productIds: { isEmpty: false } }],
    },
    select: {
      amountPaid: true,
      amountExpected: true,
      currency: true,
      occurredAt: true,
      validatedAt: true,
      createdAt: true,
    },
  });

  const toDayKey = dayKeyFormatter(timezone);
  const dayTotals = new Map<string, { total: number; count: number }>();
  const monthTotals = new Map<string, { total: number; count: number }>();
  let currency = "PEN";

  for (const r of receipts) {
    const amount = Number(r.amountPaid ?? r.amountExpected);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (r.currency) currency = r.currency;
    const when = r.occurredAt ?? r.validatedAt ?? r.createdAt;
    const dayKey = toDayKey(when); // YYYY-MM-DD en la TZ del negocio
    const monthKey = dayKey.slice(0, 7);

    const day = dayTotals.get(dayKey) ?? { total: 0, count: 0 };
    day.total += amount;
    day.count += 1;
    dayTotals.set(dayKey, day);

    const month = monthTotals.get(monthKey) ?? { total: 0, count: 0 };
    month.total += amount;
    month.count += 1;
    monthTotals.set(monthKey, month);
  }

  // Serie diaria: últimos 30 días, incluyendo días sin pagos (en 0)
  const daily: SeriesPoint[] = [];
  const now = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const key = toDayKey(d);
    const bucket = dayTotals.get(key) ?? { total: 0, count: 0 };
    const [, m, day] = key.split("-").map(Number);
    daily.push({
      date: key,
      label: `${day} ${MONTH_LABELS[(m ?? 1) - 1]}`,
      total: Math.round(bucket.total * 100) / 100,
      count: bucket.count,
    });
  }

  // Serie mensual: últimos 12 meses
  const monthly: SeriesPoint[] = [];
  const nowKey = toDayKey(now); // YYYY-MM-DD
  let [y, m] = nowKey.split("-").map(Number);
  const monthKeys: string[] = [];
  for (let i = 0; i < 12; i++) {
    monthKeys.unshift(`${y}-${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  for (const key of monthKeys) {
    const bucket = monthTotals.get(key) ?? { total: 0, count: 0 };
    const [yy, mm] = key.split("-").map(Number);
    monthly.push({
      date: key,
      label: `${MONTH_LABELS[(mm ?? 1) - 1]} ${String(yy).slice(2)}`,
      total: Math.round(bucket.total * 100) / 100,
      count: bucket.count,
    });
  }

  const currentMonth = monthly[monthly.length - 1] ?? { total: 0, count: 0 };

  const avgTicket = currentMonth.count > 0 ? Math.round((currentMonth.total / currentMonth.count) * 100) / 100 : 0;

  return {
    flows: { total: flowsTotal, active: flowsActive, activeSessions: activeFlowSessions },
    payments: {
      currency,
      daily,
      monthly,
      monthTotal: currentMonth.total,
      monthCount: currentMonth.count,
    },
    metrics: {
      currency,
      customersTotal,
      customersNewThisMonth,
      conversationsTotal,
      conversionRate: Math.round(conversionRate * 10000) / 100, // %
      avgTicket,
      autoApprovals,
      manualApprovals,
      deliveryRate: Math.round(deliveryRate * 10000) / 100, // %
      digitalSalesTotal,
      digitalSalesDelivered,
      paymentMethods,
    },
  };
}
