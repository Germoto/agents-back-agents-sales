/**
 * Ventana de horario hábil para el envío de recordatorios. Un recordatorio que
 * caiga fuera de [startHour, endHour) (hora local del tenant) se reprograma al
 * siguiente startHour válido. Sin dependencias (usa Intl, igual que flow-engine).
 */

/**
 * spreadMinutes: DISPERSIÓN AL ABRIR. Lo que cae fuera de horario no se
 * reprograma a la apertura exacta (startHour:00:00 — decenas de mensajes al
 * mismo segundo = ráfaga que WhatsApp castiga) sino a un minuto al azar dentro
 * de los primeros `spreadMinutes` de la ventana. 0 = apagado.
 */
export type QuietHours = { startHour: number; endHour: number; spreadMinutes: number };

export const DEFAULT_SPREAD_MINUTES = 90;
export const DEFAULT_QUIET_HOURS: QuietHours = { startHour: 7, endHour: 23, spreadMinutes: DEFAULT_SPREAD_MINUTES };

/** Normaliza/valida la config de horario (de followupConfig.quietHours). */
export function normalizeQuietHours(raw: unknown): QuietHours {
  const q = raw as { startHour?: unknown; endHour?: unknown; spreadMinutes?: unknown } | null | undefined;
  let start = Number(q?.startHour);
  let end = Number(q?.endHour);
  let spread = Number(q?.spreadMinutes);
  if (!Number.isInteger(start) || start < 0 || start > 23) start = DEFAULT_QUIET_HOURS.startHour;
  if (!Number.isInteger(end) || end < 1 || end > 24) end = DEFAULT_QUIET_HOURS.endHour;
  if (!Number.isFinite(spread) || spread < 0 || spread > 180) spread = DEFAULT_SPREAD_MINUTES;
  // Ventana inválida (apertura >= cierre) → default seguro.
  if (start >= end) return { ...DEFAULT_QUIET_HOURS };
  return { startHour: start, endHour: end, spreadMinutes: Math.round(spread) };
}

/** Desplazamiento aleatorio (ms) dentro de la dispersión, recortado a media ventana. */
function openingJitterMs(quiet: QuietHours): number {
  const windowMinutes = (quiet.endHour - quiet.startHour) * 60;
  const spread = Math.min(quiet.spreadMinutes ?? 0, Math.floor(windowMinutes / 2));
  if (spread <= 0) return 0;
  return Math.floor(Math.random() * spread * 60_000);
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
 * (hoy si es antes de abrir; mañana si es al/después de cerrar) MÁS la
 * dispersión al azar (ver spreadMinutes). Dentro de la ventana, devuelve
 * `sendAt` sin cambios.
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

  const jitter = openingJitterMs(quiet);
  if (parts.hour < startHour) {
    // Antes de abrir → hoy a startHour (+ dispersión)
    return new Date(zonedTimeToUtc(parts.year, parts.month, parts.day, startHour, tz).getTime() + jitter);
  }
  // Al/después de cerrar → mañana a startHour (rollover de mes/año vía UTC).
  const roll = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  roll.setUTCDate(roll.getUTCDate() + 1);
  return new Date(
    zonedTimeToUtc(roll.getUTCFullYear(), roll.getUTCMonth() + 1, roll.getUTCDate(), startHour, tz).getTime() + jitter,
  );
}

/**
 * Ritmo de envío de recordatorios por empresa (anti-ráfaga): separación al azar
 * en [minSec, maxSec] entre recordatorios consecutivos de la MISMA empresa y
 * tope de envíos visibles por hora. De followupConfig.pacing; defaults por env.
 */
export type ReminderPacing = { minSec: number; maxSec: number; maxPerHour: number };

export function normalizePacing(raw: unknown, defaults: ReminderPacing): ReminderPacing {
  const p = raw as { minSec?: unknown; maxSec?: unknown; maxPerHour?: unknown } | null | undefined;
  let min = Number(p?.minSec);
  let max = Number(p?.maxSec);
  let cap = Number(p?.maxPerHour);
  if (!Number.isFinite(min) || min < 5 || min > 600) min = defaults.minSec;
  if (!Number.isFinite(max) || max < min || max > 900) max = Math.max(min, defaults.maxSec);
  if (!Number.isFinite(cap) || cap < 5 || cap > 500) cap = defaults.maxPerHour;
  return { minSec: Math.round(min), maxSec: Math.round(max), maxPerHour: Math.round(cap) };
}

/** Milisegundos al azar en [minSec, maxSec]. */
export function pacingDelayMs(p: { minSec: number; maxSec: number }, factor = 1): number {
  const span = Math.max(0, p.maxSec - p.minSec);
  return Math.round((p.minSec + Math.random() * span) * 1000 * factor);
}
