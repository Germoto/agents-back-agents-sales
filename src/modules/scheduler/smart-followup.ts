/**
 * Seguimiento inteligente: opciones de `AgentConfig.followupConfig` que hacen que los
 * recordatorios automáticos tengan en cuenta la conversación. Todo nace APAGADO: sin
 * estas claves el comportamiento es el de siempre.
 *
 *  - resume:   no repetir pasos ya enviados (la secuencia sigue en el siguiente).
 *  - postpone: el agente pospone el seguimiento cuando el cliente lo pide.
 *  - aiReview: la IA revisa el chat antes de enviar un recordatorio (tiene costo).
 *
 * Aquí viven el normalizador y las funciones puras (sin BD) que comparten el agente,
 * el worker, el simulador y el Copiloto.
 */
import { zonedParts, zonedTimeToUtc } from "./quiet-hours";

export type SmartFollowup = {
  resume: { enabled: boolean };
  postpone: {
    enabled: boolean;
    defaultHours: number;
    defaultHour: number;
    /** Mensaje que deja el sistema cuando el agente promete una fecha y no la programa. */
    fallbackMessage: string;
  };
  aiReview: { enabled: boolean; dailyLimit: number; criteria: string | null };
};

/** Mensaje por defecto de la red de seguridad de posponer (admite variantes {a|b}). */
export const DEFAULT_POSTPONE_FALLBACK_MESSAGE =
  "{hola|buenas}.. como quedamos te escribo hoy.. {seguimos con tu pedido?|te paso los datos para el pago?}";
export const POSTPONE_FALLBACK_MAX = 600;

export const DEFAULT_SMART_FOLLOWUP: SmartFollowup = {
  resume: { enabled: false },
  postpone: { enabled: false, defaultHours: 24, defaultHour: 10, fallbackMessage: DEFAULT_POSTPONE_FALLBACK_MESSAGE },
  aiReview: { enabled: false, dailyLimit: 100, criteria: null },
};

/** Ventana máxima para posponer y para "recordar" pasos ya enviados. */
export const FOLLOWUP_MEMORY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function intIn(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** Normaliza `followupConfig` (JSON libre) a las opciones de seguimiento inteligente. */
export function normalizeSmartFollowup(raw: unknown): SmartFollowup {
  const f = (raw ?? {}) as {
    resume?: { enabled?: unknown } | null;
    postpone?: { enabled?: unknown; defaultHours?: unknown; defaultHour?: unknown; fallbackMessage?: unknown } | null;
    aiReview?: { enabled?: unknown; dailyLimit?: unknown; criteria?: unknown } | null;
  };
  const d = DEFAULT_SMART_FOLLOWUP;
  const fallback = typeof f.postpone?.fallbackMessage === "string" ? f.postpone.fallbackMessage.trim().slice(0, POSTPONE_FALLBACK_MAX) : "";
  const criteria = typeof f.aiReview?.criteria === "string" ? f.aiReview.criteria.trim().slice(0, 600) : "";
  return {
    resume: { enabled: f.resume?.enabled === true },
    postpone: {
      enabled: f.postpone?.enabled === true,
      defaultHours: intIn(f.postpone?.defaultHours, 1, 720, d.postpone.defaultHours),
      defaultHour: intIn(f.postpone?.defaultHour, 0, 23, d.postpone.defaultHour),
      fallbackMessage: fallback || d.postpone.fallbackMessage,
    },
    aiReview: {
      enabled: f.aiReview?.enabled === true,
      dailyLimit: intIn(f.aiReview?.dailyLimit, 10, 2000, d.aiReview.dailyLimit),
      criteria: criteria || null,
    },
  };
}

/** "24 horas", "3 días": la espera por defecto de posponer, en palabras. */
export function waitInWords(hours: number): string {
  if (hours >= 48 && hours % 24 === 0) return `${hours / 24} días`;
  return hours === 1 ? "1 hora" : `${hours} horas`;
}

/**
 * Frases que interpretan la configuración para el dueño (Copiloto → ver_configuracion).
 * El panel arma las suyas con el mismo sentido (cuadro «Con esta configuración:»).
 */
export function describeSmartFollowup(s: SmartFollowup): { resume: string; postpone: string; aiReview: string } {
  const hh = `${String(s.postpone.defaultHour).padStart(2, "0")}:00`;
  return {
    resume: s.resume.enabled
      ? "Si un cliente responde y vuelve a callar, la secuencia sigue en el paso siguiente: no repite los pasos que ya recibió (memoria de 30 días; una compra aprobada o reiniciar la conversación la reinicia)."
      : "Apagado: cada vez que el cliente responde y calla, la secuencia vuelve a empezar desde el paso 1.",
    postpone: s.postpone.enabled
      ? `Si el cliente pide que le escriban otro día, el agente programa UN mensaje para ese momento (si dice el día sin hora, a las ${hh}; si solo dice «después», en ${waitInWords(s.postpone.defaultHours)}). Hasta esa fecha no salen recordatorios y la secuencia normal empieza a contar desde ahí. Si el agente promete una fecha y no la programa, el sistema se lo exige; si aun así no lo hace, el sistema programa ese día este mensaje: «${s.postpone.fallbackMessage}». Si no logra leer la fecha, deja una nota interna en el chat.`
      : "Apagado: el agente no puede pausar los recordatorios aunque el cliente pida que le escriban después.",
    aiReview: s.aiReview.enabled
      ? `Antes de cada recordatorio a un cliente que respondió después del recordatorio anterior, la IA lee el chat y decide si enviarlo. Máximo ${s.aiReview.dailyLimit} revisiones al día; cada una es una consulta corta a la IA del negocio. El primer recordatorio a cada cliente nunca se revisa. Si la IA falla o se alcanza el tope, el recordatorio se envía.`
      : "Apagada: no genera gasto. Los recordatorios salen sin leer el chat.",
  };
}

/**
 * Pasos que faltan enviar y a cuántos segundos (desde el momento base) sale cada uno.
 * `lastSentIndex` = índice del último paso que el cliente YA recibió (-1 = ninguno).
 *
 * Al retomar, el primer paso pendiente sale tras max(espera del paso 1, distancia
 * original con el paso anterior) y los demás conservan sus distancias originales.
 * Ej.: pasos a 1 h, 24 h y 48 h con 1 y 2 enviados → el paso 3 sale a las 24 h.
 */
export function resumeOffsets(
  steps: Array<{ delaySeconds: number }>,
  lastSentIndex: number,
): Array<{ stepIndex: number; offsetSeconds: number }> {
  if (lastSentIndex < 0) return steps.map((s, stepIndex) => ({ stepIndex, offsetSeconds: s.delaySeconds }));
  const k = lastSentIndex + 1;
  if (k >= steps.length) return [];
  const first = Math.max(steps[0].delaySeconds, steps[k].delaySeconds - steps[k - 1].delaySeconds);
  return steps.slice(k).map((s, i) => ({
    stepIndex: k + i,
    offsetSeconds: first + Math.max(0, s.delaySeconds - steps[k].delaySeconds),
  }));
}

export type PostponeResolution = { ok: true; until: Date } | { ok: false; error: string };

/**
 * Convierte lo que pidió el cliente en un instante, en la zona del negocio:
 *  - fecha + hora → ese momento exacto;
 *  - solo fecha   → ese día a la hora por defecto;
 *  - solo hora    → hoy a esa hora, o mañana si ya pasó;
 *  - nada         → ahora + las horas por defecto.
 * Tope de 30 días; un momento ya pasado devuelve error para que el modelo corrija.
 */
export function resolvePostponeDate(
  input: { fecha?: string | null; hora?: string | null },
  opts: { now: Date; tz: string; defaultHours: number; defaultHour: number },
): PostponeResolution {
  const { now, tz } = opts;
  const fecha = (input.fecha ?? "").trim();
  const hora = (input.hora ?? "").trim();

  let hour: number | null = null;
  let minute = 0;
  if (hora) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hora);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return { ok: false, error: "hora inválida: usa el formato HH:mm de 24 horas (ej. 15:30)" };
    hour = Number(m[1]);
    minute = Number(m[2]);
  }

  let until: Date;
  if (fecha) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
    if (!m) return { ok: false, error: "fecha inválida: usa el formato AAAA-MM-DD (ej. 2026-11-14)" };
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const probe = new Date(Date.UTC(y, mo - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
      return { ok: false, error: "fecha inválida: ese día no existe en el calendario" };
    }
    until = zonedTimeToUtc(y, mo, d, hour ?? opts.defaultHour, tz, minute);
  } else if (hour !== null) {
    const p = zonedParts(now, tz);
    until = zonedTimeToUtc(p.year, p.month, p.day, hour, tz, minute);
    if (until.getTime() <= now.getTime()) {
      // Esa hora ya pasó hoy: mañana a la misma hora.
      const roll = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
      until = zonedTimeToUtc(roll.getUTCFullYear(), roll.getUTCMonth() + 1, roll.getUTCDate(), hour, tz, minute);
    }
  } else {
    until = new Date(now.getTime() + opts.defaultHours * 60 * 60 * 1000);
  }

  if (until.getTime() <= now.getTime()) {
    return { ok: false, error: "ese momento ya pasó: revisa la fecha y hora actual del prompt y envía una fecha futura" };
  }
  if (until.getTime() - now.getTime() > FOLLOWUP_MEMORY_DAYS * DAY_MS) {
    return { ok: false, error: `máximo ${FOLLOWUP_MEMORY_DAYS} días hacia adelante` };
  }
  return { ok: true, until };
}

/** Fecha legible en la zona del negocio (ej. "sábado 14 de noviembre, 10:00"). */
export function formatPostponeDate(date: Date, tz: string): string {
  try {
    const day = new Intl.DateTimeFormat("es-PE", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(date);
    const p = zonedParts(date, tz);
    return `${day}, ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  } catch {
    return date.toISOString();
  }
}

/** Estado mínimo que usa este módulo (evita importar el tipo completo del agente). */
type FollowupState = {
  followupResetAt?: string | null;
  followupPostponed?: { until: string; body: string; setAt: string } | null;
};

/**
 * Marca "desde aquí la secuencia empieza de cero" (pago aprobado, reinicio): los pasos
 * enviados antes ya no cuentan y la pausa pedida por el cliente se levanta.
 */
export function markFollowupReset(state: FollowupState, now = new Date()): void {
  state.followupResetAt = now.toISOString();
  state.followupPostponed = null;
}

/** Pausa vigente pedida por el cliente (null si no hay o si ya llegó la fecha). */
export function activePostpone(state: FollowupState, now = new Date()): { until: Date; body: string } | null {
  const p = state.followupPostponed;
  if (!p || typeof p.until !== "string") return null;
  const until = new Date(p.until);
  if (Number.isNaN(until.getTime()) || until.getTime() <= now.getTime()) return null;
  return { until, body: typeof p.body === "string" ? p.body : "" };
}

/** Desde cuándo cuentan los pasos ya enviados: hace 30 días o el último reinicio. */
export function followupMemoryCutoff(state: FollowupState, now = new Date()): Date {
  const floor = new Date(now.getTime() - FOLLOWUP_MEMORY_DAYS * DAY_MS);
  const reset = state.followupResetAt ? new Date(state.followupResetAt) : null;
  return reset && !Number.isNaN(reset.getTime()) && reset.getTime() > floor.getTime() ? reset : floor;
}
