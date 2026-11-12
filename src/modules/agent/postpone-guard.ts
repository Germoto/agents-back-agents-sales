/**
 * Guardia de la fecha prometida. Detecta, sobre el texto final del agente, la promesa
 * de volver a escribir en un momento concreto («te escribo el lunes a las 9») y lee
 * ese día y hora para poder programarlo si el modelo no llamó a posponer_seguimiento.
 * Funciones puras: el runtime decide qué hacer con el resultado.
 */

import { zonedParts } from "../scheduler/quiet-hours";

const norm = (t: string) =>
  t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

/** El agente dice que será quien retome el contacto. */
const CONTACT_RE =
  /\b(te|le|les)\s+(vuelvo\s+a\s+(escribir|contactar|hablar|buscar)|voy\s+a\s+(escribir|contactar|hablar|buscar)|estare\s+(escribiendo|contactando|hablando))\b|\b(te|le|les)\s+(escribo|escribire|escribimos|contacto(?!\s+con)|contactare|contactamos|hablo|hablare|busco|buscare|llamo|llamare|aviso(?!\s+que)|avisare|saludo|mando\s+(un\s+)?mensaje|envio\s+(un\s+)?mensaje)\b|\b(hablamos|conversamos|retomamos|coordinamos|nos\s+(hablamos|escribimos|comunicamos))\b|\b(lo|la)\s+(vemos|retomamos|coordinamos)\b|\b(quedo|estare|estaremos|quedamos)\s+(al\s+)?(pendiente|atent[oa]s?)\b/;
/** Ofrecimiento condicionado: todavía no promete nada. */
const OFFER_RE =
  /\b(si\s+(quieres|prefieres|deseas|gustas|te\s+parece)|cuando\s+(quieras|gustes|puedas|me\s+digas)|avisame|me\s+avisas|me\s+escribes|escribeme|dime\s+(si|cuando|que\s+dia))\b/;

const WEEKDAYS = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const NUM_WORDS: Record<string, number> = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
};
const NUM = `(\\d{1,2}|${Object.keys(NUM_WORDS).join("|")})`;
const num = (raw: string) => (/^\d+$/.test(raw) ? Number(raw) : NUM_WORDS[raw] ?? NaN);

const WEEKDAY_RE = new RegExp(`\\b(${WEEKDAYS.join("|")})\\b`);
/** «mañana» como día siguiente, no como parte del día («la mañana», «de la mañana»). */
const TOMORROW_RE = /(?<!\b(?:la|esta|cada|toda|buena)\s)\bmanana\b/;
const DAY_AFTER_RE = /\bpasado\s+manana\b/;
const DATE_OF_MONTH_RE = new RegExp(`\\b(\\d{1,2})\\s+de\\s+(${MONTHS.join("|")}|setiembre)\\b`);
const SLASH_DATE_RE = /\b(\d{1,2})\/(\d{1,2})\b/;
const DAY_NUMBER_RE = /\bel\s+(?:dia\s+)?(\d{1,2})\b(?!\s*(?:[:.]\d|am\b|pm\b|a\.?\s?m\b|p\.?\s?m\b|de\s+la|horas?\b|h\b|%|soles|dolares|productos?|pack|mensajes?))/;
const IN_DAYS_RE = new RegExp(`\\ben\\s+${NUM}\\s+(dias?|semanas?)\\b`);
const IN_HOURS_RE = new RegExp(`\\ben\\s+${NUM}\\s+horas?\\b`);
const HOUR_AT_RE = /\ba\s+las?\s+(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.?\s?m\b\.?|p\.?\s?m\b\.?)?/;
const HOUR_MARKED_RE = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.?\s?m\b\.?|p\.?\s?m\b\.?)/;
const NOON_RE = /\b(al|del)\s+mediodia\b/;
/** Momentos que cuentan como promesa pero no se pueden convertir en una fecha exacta. */
const VAGUE_RE = /\b(proxima\s+semana|semana\s+que\s+viene|otra\s+semana|fin\s+de\s+semana|fin\s+de\s+mes|fines\s+de\s+mes|quincena)\b/;

function hasTimeRef(s: string): boolean {
  return (
    WEEKDAY_RE.test(s) ||
    TOMORROW_RE.test(s) ||
    DATE_OF_MONTH_RE.test(s) ||
    SLASH_DATE_RE.test(s) ||
    IN_DAYS_RE.test(s) ||
    IN_HOURS_RE.test(s) ||
    HOUR_AT_RE.test(s) ||
    HOUR_MARKED_RE.test(s) ||
    NOON_RE.test(s) ||
    VAGUE_RE.test(s) ||
    (/\bel\s+dia\s+\d{1,2}\b/.test(s) && DAY_NUMBER_RE.test(s))
  );
}

/** Oraciones del texto (normalizadas) donde el agente promete escribir en un momento concreto. */
function promiseSentences(text: string | null | undefined): string[] {
  const full = norm((text ?? "").trim());
  if (!full) return [];
  return full
    .split(/(?<=[.!?\n])/)
    .map((s) => s.trim())
    .filter((s) => s && !/[¿?]/.test(s) && CONTACT_RE.test(s) && !OFFER_RE.test(s) && hasTimeRef(s));
}

/**
 * ¿El texto promete volver a escribirle al cliente en un día u hora concretos? Se
 * evalúa oración por oración: tiene que decir que el agente retoma el contacto y
 * nombrar un momento, sin ser una pregunta ni un ofrecimiento («si quieres te escribo»).
 */
export function promisesFollowupDate(text: string | null | undefined): boolean {
  return promiseSentences(text).length > 0;
}

type Parsed = { fecha?: string; hour?: number; minute?: number; marked?: boolean };

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

function parseHour(s: string): Pick<Parsed, "hour" | "minute" | "marked"> {
  if (NOON_RE.test(s)) return { hour: 12, minute: 0, marked: true };
  const m = HOUR_MARKED_RE.exec(s) ?? HOUR_AT_RE.exec(s);
  if (!m) {
    // Sin hora exacta, la parte del día da una hora razonable.
    if (/\b(por|en|a)\s+la\s+tarde\b/.test(s)) return { hour: 15, minute: 0, marked: true };
    if (/\b(por|en|a)\s+la\s+noche\b/.test(s)) return { hour: 19, minute: 0, marked: true };
    return {};
  }
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (hour > 23 || minute > 59) return {};
  const mark = (m[3] ?? "").replace(/[.\s]/g, "");
  const rest = s.slice(m.index + m[0].length, m.index + m[0].length + 24);
  const pm = mark === "pm" || /^\s*(de\s+la\s+(tarde|noche)|en\s+la\s+(tarde|noche)|por\s+la\s+(tarde|noche))/.test(rest);
  const am = mark === "am" || /^\s*(de\s+la\s+(manana|madrugada)|en\s+la\s+manana|por\s+la\s+manana)/.test(rest);
  if (pm) {
    if (hour < 12) hour += 12;
    return { hour, minute, marked: true };
  }
  if (am) {
    if (hour === 12) hour = 0;
    return { hour, minute, marked: true };
  }
  if (hour > 12) return { hour, minute, marked: true };
  // Sin «am/pm»: de 1 a 7 se entiende la tarde; de 8 a 12, la mañana o el mediodía.
  return { hour: hour >= 1 && hour <= 7 ? hour + 12 : hour, minute, marked: false };
}

function parseOne(s: string, now: Date, tz: string): Parsed {
  const p = zonedParts(now, tz);
  const today = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const plusDays = (n: number) => ymd(new Date(today.getTime() + n * 86_400_000));
  const out: Parsed = {};

  const inHours = IN_HOURS_RE.exec(s);
  if (inHours) {
    const n = num(inHours[1]);
    if (n >= 1) {
      const z = zonedParts(new Date(now.getTime() + n * 3_600_000), tz);
      return { fecha: `${z.year}-${pad(z.month)}-${pad(z.day)}`, hour: z.hour, minute: z.minute, marked: true };
    }
  }

  const dom = DATE_OF_MONTH_RE.exec(s);
  const slash = SLASH_DATE_RE.exec(s);
  const inDays = IN_DAYS_RE.exec(s);
  const wd = WEEKDAY_RE.exec(s);
  const dayNum = DAY_NUMBER_RE.exec(s);
  const explicit = (day: number, month: number) => {
    if (day < 1 || day > 31 || month < 1 || month > 12) return;
    let d = new Date(Date.UTC(p.year, month - 1, day));
    if (d.getUTCMonth() !== month - 1) return;
    if (d.getTime() < today.getTime()) d = new Date(Date.UTC(p.year + 1, month - 1, day));
    out.fecha = ymd(d);
  };
  if (dom) {
    const name = dom[2] === "setiembre" ? "septiembre" : dom[2];
    explicit(Number(dom[1]), MONTHS.indexOf(name) + 1);
  } else if (slash) {
    explicit(Number(slash[1]), Number(slash[2]));
  } else if (DAY_AFTER_RE.test(s)) {
    out.fecha = plusDays(2);
  } else if (TOMORROW_RE.test(s)) {
    out.fecha = plusDays(1);
  } else if (inDays) {
    const n = num(inDays[1]);
    if (n >= 1) out.fecha = plusDays(inDays[2].startsWith("semana") ? n * 7 : n);
  } else if (wd) {
    // El día nombrado es su próxima ocurrencia; si es el de hoy, la semana siguiente.
    const diff = (WEEKDAYS.indexOf(wd[1]) - today.getUTCDay() + 7) % 7;
    out.fecha = plusDays(diff === 0 ? 7 : diff);
    // «el lunes 16»: si el número no calza con ese día, manda el número.
    const withNum = new RegExp(`\\b${wd[1]}\\s+(\\d{1,2})\\b(?!\\s*(?:[:.]\\d|am\\b|pm\\b|a\\.?\\s?m\\b|p\\.?\\s?m\\b|de\\s+la|horas?\\b))`).exec(s);
    if (withNum) {
      const day = Number(withNum[1]);
      let d = new Date(Date.UTC(p.year, p.month - 1, day));
      if (d.getUTCDate() === day && d.getTime() < today.getTime()) d = new Date(Date.UTC(p.year, p.month, day));
      if (d.getUTCDate() === day && d.getTime() >= today.getTime()) out.fecha = ymd(d);
    }
  } else if (dayNum) {
    const day = Number(dayNum[1]);
    if (day >= 1 && day <= 31) {
      let d = new Date(Date.UTC(p.year, p.month - 1, day));
      if (d.getUTCDate() !== day || d.getTime() < today.getTime()) d = new Date(Date.UTC(p.year, p.month, day));
      if (d.getUTCDate() === day) out.fecha = ymd(d);
    }
  } else if (/\bhoy\b/.test(s)) {
    out.fecha = plusDays(0);
  }

  return { ...out, ...parseHour(s) };
}

/**
 * Lee el día y la hora prometidos. Primero en la promesa del agente; lo que falte (o
 * una hora sin «am/pm») se completa con el último mensaje del cliente, que es quien
 * pidió la fecha. Devuelve null si no se pudo leer ni el día ni la hora.
 */
export function parsePromisedDate(
  text: string | null | undefined,
  opts: { now: Date; tz: string; customerText?: string | null },
): { fecha?: string; hora?: string } | null {
  const sentences = promiseSentences(text);
  const own = parseOne(sentences.length ? sentences.join(" ") : norm(text ?? ""), opts.now, opts.tz);
  const theirs = opts.customerText ? parseOne(norm(opts.customerText), opts.now, opts.tz) : {};
  const fecha = own.fecha ?? theirs.fecha;
  let hour = own.hour;
  let minute = own.minute ?? 0;
  if (hour === undefined) {
    hour = theirs.hour;
    minute = theirs.minute ?? 0;
  } else if (!own.marked && theirs.marked && theirs.hour !== undefined && theirs.hour % 12 === hour % 12) {
    // «a las 9» del agente + «9 pm» del cliente: manda lo que dijo el cliente.
    hour = theirs.hour;
    minute = theirs.minute ?? minute;
  }
  if (!fecha && hour === undefined) return null;
  return { ...(fecha ? { fecha } : {}), ...(hour !== undefined ? { hora: `${pad(hour)}:${pad(minute)}` } : {}) };
}
