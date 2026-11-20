/**
 * Reglas puras de la cola de altas a grupos de WhatsApp (sin base de datos).
 *
 * WhatsApp bloquea el número cuando salen varias altas seguidas: en los logs de SMS
 * Tools (16 al 18-nov-2026) el bloqueo llegó tras 6 a 8 altas a un minuto de distancia,
 * y nunca con 30 minutos o más entre una y otra. Por eso el ritmo se mide en MINUTOS
 * ENTRE ALTAS (mínimo 15), con tope diario y horario, y la cola nunca suelta lo
 * acumulado de golpe.
 */

export type GroupHours = { from: number; to: number };

export type GroupPacing = {
  /** Minutos mínimos entre un alta y la siguiente del negocio. */
  gapMinutes: number;
  /** Máximo de altas en 24 horas. */
  perDay: number;
  /** Horario de altas en hora local del negocio (0 a 24). from 0 y to 24 = todo el día. */
  hours: GroupHours;
};

export const DEFAULT_GROUP_PACING: GroupPacing = { gapMinutes: 30, perDay: 30, hours: { from: 8, to: 21 } };

export const GROUP_PACING_LIMITS = {
  gapMinutes: { min: 15, max: 240 },
  perDay: { min: 1, max: 60 },
  hour: { min: 0, max: 24 },
} as const;

/** Azar máximo que se suma al hueco (25 %): las altas no salen a intervalos exactos. */
export const GAP_JITTER = 0.25;

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (value === null || value === undefined || value === "" || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function asObj(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/**
 * Normaliza el ritmo guardado. La forma anterior ({perMinute, perHour, perDay}) se
 * ignora a propósito: quien tenía «1 por minuto» pasa al ritmo seguro de fábrica.
 */
export function normalizePacing(raw: unknown): GroupPacing {
  const r = asObj(raw);
  const isNewShape = r.gapMinutes !== undefined;
  const h = asObj(r.hours);
  const L = GROUP_PACING_LIMITS;
  let from = clamp(h.from, L.hour.min, L.hour.max, DEFAULT_GROUP_PACING.hours.from);
  let to = clamp(h.to, L.hour.min, L.hour.max, DEFAULT_GROUP_PACING.hours.to);
  // Un horario vacío o invertido no tiene sentido: vuelve al de fábrica.
  if (to <= from) ({ from, to } = DEFAULT_GROUP_PACING.hours);
  return {
    gapMinutes: clamp(r.gapMinutes, L.gapMinutes.min, L.gapMinutes.max, DEFAULT_GROUP_PACING.gapMinutes),
    perDay: clamp(isNewShape ? r.perDay : undefined, L.perDay.min, L.perDay.max, DEFAULT_GROUP_PACING.perDay),
    hours: { from, to },
  };
}

// ---------------------------------------------------------------------------
// Pausa de la cuenta (vive en el mismo JSON que el ritmo)
// ---------------------------------------------------------------------------

export type GroupPauseKind = "bloqueo" | "desconectado";
export type GroupPause = { until: Date; kind: GroupPauseKind; reason: string };

/** Ante un 500 del gateway las altas del negocio se detienen 24 h (pedido de SMS Tools). */
export const BLOCK_PAUSE_MS = 24 * 60 * 60_000;
/** Cuenta desconectada: no es un bloqueo; se vuelve a mirar cada 30 min. */
export const DISCONNECTED_RECHECK_MS = 30 * 60_000;

/** Pausa vigente de la cuenta, o null. Una pausa vencida ya no cuenta. */
export function pauseOf(raw: unknown, now = new Date()): GroupPause | null {
  const r = asObj(raw);
  const until = typeof r.pausedUntil === "string" ? new Date(r.pausedUntil) : null;
  if (!until || Number.isNaN(until.getTime()) || until.getTime() <= now.getTime()) return null;
  return {
    until,
    kind: r.pauseKind === "desconectado" ? "desconectado" : "bloqueo",
    reason: typeof r.pauseReason === "string" ? r.pauseReason : "",
  };
}

/** «not connected» en el detalle del gateway = cuenta desconectada, no bloqueo. */
export function pauseKindFor(detail: string): GroupPauseKind {
  return /not connected/i.test(detail) ? "desconectado" : "bloqueo";
}

// ---------------------------------------------------------------------------
// Horario
// ---------------------------------------------------------------------------

/** Hora local (0 a 23, con minutos como fracción) en la zona del negocio. */
export function localHour(now: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    return (h % 24) + m / 60;
  } catch {
    return now.getUTCHours() + now.getUTCMinutes() / 60;
  }
}

export function withinHours(pacing: GroupPacing, now: Date, timeZone: string): boolean {
  const { from, to } = pacing.hours;
  if (from <= 0 && to >= 24) return true;
  const h = localHour(now, timeZone);
  return h >= from && h < to;
}

// ---------------------------------------------------------------------------
// Hueco entre altas
// ---------------------------------------------------------------------------

/**
 * Hueco real tras un alta: los minutos configurados más un azar de 0 a 25 %. El azar
 * sale de la hora del alta anterior, así es el mismo en cada pasada del worker (si se
 * sorteara de nuevo cada minuto, ganaría siempre el sorteo más corto).
 */
export function gapMsAfter(pacing: GroupPacing, lastAt: Date): number {
  const base = pacing.gapMinutes * 60_000;
  // Mezcla entera de 32 bits (sin perder precisión): reparte parejo entre 0 y 1.
  let x = Math.floor(lastAt.getTime() / 1000) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  const unit = ((x ^ (x >>> 16)) >>> 0) / 0xffffffff;
  return Math.round(base * (1 + unit * GAP_JITTER));
}

/**
 * Cuánto falta para la próxima alta: 0 = ya; null = hoy no (tope del día alcanzado,
 * fuera de horario o cuenta en pausa). Nunca devuelve menos que el hueco pendiente,
 * así al abrir el horario o terminar una pausa no sale lo acumulado de golpe.
 */
export function nextAddWaitMs(input: {
  pacing: GroupPacing;
  now: Date;
  timeZone: string;
  lastAt: Date | null;
  lastDay: number;
  paused: boolean;
}): number | null {
  const { pacing, now, lastAt } = input;
  if (input.paused) return null;
  if (input.lastDay >= pacing.perDay) return null;
  if (!withinHours(pacing, now, input.timeZone)) return null;
  if (!lastAt) return 0;
  return Math.max(0, gapMsAfter(pacing, lastAt) - (now.getTime() - lastAt.getTime()));
}

/** Altas que caben en un día con este ritmo (horario y tope diario). */
export function dailyCapacity(pacing: GroupPacing): number {
  const windowMinutes = Math.max(1, (pacing.hours.to - pacing.hours.from) * 60);
  const avgGap = pacing.gapMinutes * (1 + GAP_JITTER / 2);
  return Math.max(1, Math.min(pacing.perDay, Math.floor(windowMinutes / avgGap) + 1));
}

/** Minutos aproximados para vaciar una cola de `pending` números al ritmo del negocio. */
export function estimateMinutes(pending: number, pacing: GroupPacing = DEFAULT_GROUP_PACING): number {
  if (pending <= 0) return 0;
  const capacity = dailyCapacity(pacing);
  const fullDays = Math.floor((pending - 1) / capacity);
  const rest = pending - fullDays * capacity;
  const avgGap = pacing.gapMinutes * (1 + GAP_JITTER / 2);
  return Math.round(fullDays * 24 * 60 + rest * avgGap);
}

// ---------------------------------------------------------------------------
// Prioridad y número oculto
// ---------------------------------------------------------------------------

/**
 * Niveles de la cola, del primero al último: lo que se va vendiendo sale antes que
 * cualquier otra cosa, y el lote del CRM va al final.
 */
export const SOURCE_TIERS = [
  ["VENTA", "COBRO"],
  ["PRESENTACION", "AGENTE", "FLUJO"],
  ["MANUAL", "COPILOTO"],
  ["LOTE"],
] as const;

export function tierOf(source: string): number {
  const i = SOURCE_TIERS.findIndex((tier) => (tier as readonly string[]).includes(source));
  return i === -1 ? SOURCE_TIERS.length - 1 : i;
}

/**
 * Cliente con número oculto: WhatsApp entrega un pseudo-número de 13 a 16 dígitos. No
 * se puede agregar por la API (WhatsApp lo rechaza): se le envía el link del grupo.
 */
export function isHiddenNumber(phone: string | null | undefined, waIsLid?: boolean | null): boolean {
  if (waIsLid) return true;
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 13 && digits.length <= 16;
}

const INVITE_LINK_RE = /^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]{10,64}(?:\?[\w=&%.-]*)?$/;

/** Link de invitación de un grupo de WhatsApp (el dueño lo copia desde su grupo). */
export function isInviteLink(value: string | null | undefined): boolean {
  return INVITE_LINK_RE.test((value ?? "").trim());
}

export const DEFAULT_LINK_MESSAGE = "Hola {nombre} 👋 Te invitamos a nuestro grupo «{grupo}». Entra con este link: {link}";

/**
 * Texto del mensaje con el link. Usa el mensaje propio del grupo si existe: si no trae
 * {link}, el link va en una línea aparte al final. Sin mensaje propio, el de fábrica.
 */
export function buildLinkMessage(template: string | null | undefined, vars: { nombre: string; grupo: string; link: string }): string {
  const base = (template ?? "").trim() || DEFAULT_LINK_MESSAGE;
  const withLink = /\{link\}/i.test(base) ? base : `${base}\n${vars.link}`;
  return withLink
    .replace(/\{link\}/gi, vars.link)
    .replace(/\{nombre\}/gi, vars.nombre)
    .replace(/\{grupo\}/gi, vars.grupo)
    .replace(/[^\S\n]{2,}/g, " ")
    .replace(/[^\S\n]+([,.!?])/g, "$1")
    .trim();
}
