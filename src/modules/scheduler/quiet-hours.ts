/**
 * Ventana de horario hábil para el envío de recordatorios. Un recordatorio que
 * caiga fuera de [startHour, endHour) (hora local del tenant) se reprograma al
 * siguiente startHour válido. Sin dependencias (usa Intl, igual que flow-engine).
 */

export type QuietHours = { startHour: number; endHour: number };

export const DEFAULT_QUIET_HOURS: QuietHours = { startHour: 7, endHour: 23 };

/** Normaliza/valida la config de horario (de followupConfig.quietHours). */
export function normalizeQuietHours(raw: unknown): QuietHours {
  const q = raw as { startHour?: unknown; endHour?: unknown } | null | undefined;
  let start = Number(q?.startHour);
  let end = Number(q?.endHour);
  if (!Number.isInteger(start) || start < 0 || start > 23) start = DEFAULT_QUIET_HOURS.startHour;
  if (!Number.isInteger(end) || end < 1 || end > 24) end = DEFAULT_QUIET_HOURS.endHour;
  // Ventana inválida (apertura >= cierre) → default seguro.
  if (start >= end) return { ...DEFAULT_QUIET_HOURS };
  return { startHour: start, endHour: end };
}

/** Partes de reloj de pared (wall-clock) del instante en la zona horaria. */
function zonedParts(date: Date, tz: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  let hour = get("hour");
  if (hour === 24) hour = 0; // algunos engines devuelven "24" a medianoche
  return { year: get("year"), month: get("month"), day: get("day"), hour, minute: get("minute"), second: get("second") };
}

/** Offset (min) de la zona en ese instante: (wall-clock leído como UTC) − UTC real. */
function tzOffsetMinutes(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}

/** Instante UTC correspondiente a una pared-local (y,m,d,hour:00) en la zona. */
function zonedTimeToUtc(y: number, m: number, d: number, hour: number, tz: string): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, hour, 0, 0));
  const offset = tzOffsetMinutes(guess, tz);
  return new Date(guess.getTime() - offset * 60000);
}

/**
 * Si `sendAt` cae fuera de la ventana, devuelve el próximo startHour válido
 * (hoy si es antes de abrir; mañana si es al/después de cerrar). Dentro de la
 * ventana, devuelve `sendAt` sin cambios.
 */
export function clampToBusinessHours(sendAt: Date, tz: string, quiet: QuietHours): Date {
  let parts: ReturnType<typeof zonedParts>;
  try {
    parts = zonedParts(sendAt, tz);
  } catch {
    return sendAt; // zona inválida: no tocar
  }
  const { startHour, endHour } = quiet;
  if (parts.hour >= startHour && parts.hour < endHour) return sendAt;

  if (parts.hour < startHour) {
    // Antes de abrir → hoy a startHour
    return zonedTimeToUtc(parts.year, parts.month, parts.day, startHour, tz);
  }
  // Al/después de cerrar → mañana a startHour (rollover de mes/año vía UTC).
  const roll = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  roll.setUTCDate(roll.getUTCDate() + 1);
  return zonedTimeToUtc(roll.getUTCFullYear(), roll.getUTCMonth() + 1, roll.getUTCDate(), startHour, tz);
}
