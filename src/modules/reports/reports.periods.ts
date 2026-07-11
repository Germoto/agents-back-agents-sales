/**
 * Períodos CERRADOS para los reportes automáticos, calculados en la zona
 * horaria del tenant sin librería de fechas (Intl, mismo patrón que
 * scheduler/quiet-hours y dashboard.service):
 *   - daily:   ayer.
 *   - weekly:  lunes→domingo de la semana pasada.
 *   - monthly: el mes anterior completo.
 *
 * `key` identifica el período (dedupe/claim del worker): el disparo NO depende
 * de "hoy es lunes/día 1" — se envía cuando la key del último período cerrado
 * difiere de la última enviada (robusto a downtime: si el server estuvo caído
 * el lunes, el martes se envía la semana pasada igual; períodos más viejos
 * saltados no se backfillean).
 */

export type ReportKind = "daily" | "weekly" | "monthly";

export type ClosedPeriod = {
  key: string; // daily/weekly: "YYYY-MM-DD"; monthly: "YYYY-MM"
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  label: string; // "Reporte diario" | "Reporte semanal" | "Reporte mensual"
};

export const REPORT_KIND_LABELS: Record<ReportKind, string> = {
  daily: "Reporte diario",
  weekly: "Reporte semanal",
  monthly: "Reporte mensual",
};

/** Partes de reloj de pared (wall-clock) del instante en la zona horaria. */
export function zonedNowParts(date: Date, tz: string): { year: number; month: number; day: number; hour: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  let hour = get("hour");
  if (hour === 24) hour = 0; // algunos engines devuelven "24" a medianoche
  return { year: get("year"), month: get("month"), day: get("day"), hour };
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymdOf = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** Fecha de calendario local desplazada N días (aritmética pura en UTC). */
function shiftDays(p: { year: number; month: number; day: number }, days: number): Date {
  return new Date(Date.UTC(p.year, p.month - 1, p.day + days));
}

export function closedPeriodFor(kind: ReportKind, now: Date, tz: string): ClosedPeriod {
  const p = zonedNowParts(now, tz);
  const label = REPORT_KIND_LABELS[kind];

  if (kind === "daily") {
    const yesterday = ymdOf(shiftDays(p, -1));
    return { key: yesterday, from: yesterday, to: yesterday, label };
  }

  if (kind === "weekly") {
    const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(); // 0=dom..6=sáb
    const sinceMonday = (dow + 6) % 7;
    const lastMonday = shiftDays(p, -sinceMonday - 7);
    const lastSunday = shiftDays(p, -sinceMonday - 1);
    const from = ymdOf(lastMonday);
    return { key: from, from, to: ymdOf(lastSunday), label };
  }

  // monthly: mes anterior completo
  const prevYear = p.month === 1 ? p.year - 1 : p.year;
  const prevMonth = p.month === 1 ? 12 : p.month - 1;
  const lastDay = new Date(Date.UTC(p.year, p.month - 1, 0)).getUTCDate(); // día 0 del mes actual
  return {
    key: `${prevYear}-${pad(prevMonth)}`,
    from: `${prevYear}-${pad(prevMonth)}-01`,
    to: `${prevYear}-${pad(prevMonth)}-${pad(lastDay)}`,
    label,
  };
}
