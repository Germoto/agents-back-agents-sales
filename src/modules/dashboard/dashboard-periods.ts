/**
 * Periodos del dashboard, resueltos en la zona horaria del NEGOCIO (no la del
 * navegador). Todo es aritmética de fechas de calendario (YYYY-MM-DD); puro.
 */

export const DASHBOARD_PERIODS = ["today", "yesterday", "week", "last_week", "7d", "30d", "month", "last_month", "12m"] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];

export interface ResolvedRange {
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const toYmd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const fromYmd = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
};
export const addDays = (ymd: string, days: number) => {
  const d = fromYmd(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return toYmd(d);
};
export const daysBetween = (from: string, to: string) =>
  Math.round((fromYmd(to).getTime() - fromYmd(from).getTime()) / 86400000) + 1;

/** Hoy (YYYY-MM-DD) en la zona del negocio. */
export function todayIn(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Mismo día del mes anterior (recortado al último día si no existe: 31 mar → 28 feb). */
function sameDayPrevMonth(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const lastOfPrev = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
  return toYmd(new Date(Date.UTC(y, m - 2, Math.min(d, lastOfPrev))));
}

/** Rango [from, to] con su periodo anterior equivalente justo antes. */
function withPrevBefore(from: string, to: string): ResolvedRange {
  const n = daysBetween(from, to);
  return { from, to, prevFrom: addDays(from, -n), prevTo: addDays(from, -1) };
}

/**
 * Resuelve un periodo con nombre. La semana va de lunes a domingo. «Esta semana» y
 * «Este mes» se comparan con los MISMOS días de la semana / el mes anterior (lunes a
 * miércoles contra lunes a miércoles), no con los días inmediatamente anteriores.
 */
export function resolvePeriod(period: DashboardPeriod, today: string): ResolvedRange {
  const dow = fromYmd(today).getUTCDay(); // 0 = domingo
  const monday = addDays(today, -((dow + 6) % 7));
  const [y, m] = today.split("-").map(Number);
  const firstOfMonth = `${y}-${pad(m)}-01`;

  switch (period) {
    case "today":
      return withPrevBefore(today, today);
    case "yesterday":
      return withPrevBefore(addDays(today, -1), addDays(today, -1));
    case "week":
      return { from: monday, to: today, prevFrom: addDays(monday, -7), prevTo: addDays(today, -7) };
    case "last_week":
      return withPrevBefore(addDays(monday, -7), addDays(monday, -1));
    case "7d":
      return withPrevBefore(addDays(today, -6), today);
    case "month":
      return { from: firstOfMonth, to: today, prevFrom: sameDayPrevMonth(firstOfMonth), prevTo: sameDayPrevMonth(today) };
    case "last_month": {
      const lastOfPrev = addDays(firstOfMonth, -1);
      const firstOfPrev = `${lastOfPrev.slice(0, 8)}01`;
      const lastOfPrevPrev = addDays(firstOfPrev, -1);
      return { from: firstOfPrev, to: lastOfPrev, prevFrom: `${lastOfPrevPrev.slice(0, 8)}01`, prevTo: lastOfPrevPrev };
    }
    case "12m":
      return withPrevBefore(addDays(today, -364), today);
    case "30d":
    default:
      return withPrevBefore(addDays(today, -29), today);
  }
}

/** Rango pedido por el panel o el Copiloto: periodo con nombre, fechas sueltas o 30 días. */
export function resolveRange(input: { period?: string; from?: string; to?: string }, timezone: string, now = new Date()): ResolvedRange {
  const today = todayIn(timezone, now);
  if (input.period && (DASHBOARD_PERIODS as readonly string[]).includes(input.period)) {
    return resolvePeriod(input.period as DashboardPeriod, today);
  }
  if (input.from || input.to) {
    const to = input.to ?? today;
    const from = input.from ?? addDays(to, -29);
    return withPrevBefore(from <= to ? from : to, to);
  }
  return resolvePeriod("30d", today);
}
