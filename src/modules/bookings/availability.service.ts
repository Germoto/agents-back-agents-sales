/**
 * Motor de disponibilidad de la AGENDA de citas (rubro SERVICE).
 *
 * Calcula los horarios libres reales de un servicio combinando:
 *  - el horario de atención del negocio (Company.businessHours, por día de semana),
 *  - la duración y los cupos simultáneos del servicio (Product),
 *  - las citas ya agendadas (ServiceBooking SOLICITADA/CONFIRMADA),
 *  - los bloqueos de agenda (ScheduleBlock: feriados, vacaciones),
 *  - la anticipación mínima y el horizonte de reserva.
 *
 * Todo se razona en la ZONA HORARIA del negocio (Company.timezone) y se
 * persiste en UTC. Sin dependencias de fechas: mismo patrón Intl que usa el
 * driver de campañas.
 */

import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";

export interface BusinessHourRange {
  /** 0 = domingo … 6 = sábado (igual que Date.getDay). */
  day: number;
  /** "HH:mm" en la zona horaria del negocio. */
  from: string;
  to: string;
}

export interface Slot {
  /** Inicio en UTC (ISO). */
  startsAt: string;
  endsAt: string;
  /** Etiqueta lista para mostrar/decir, en la TZ del negocio ("mar 5 ago, 10:00"). */
  label: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DURATION_MIN = 60;
const DEFAULT_HORIZON_DAYS = 30;
const MAX_HORIZON_DAYS = 120;

/** Medianoche del día `offsetDays` (0 = hoy) en la TZ del negocio, como Date UTC. */
export function startOfDayInTz(tz: string, offsetDays = 0, base = new Date()): Date {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const ref = new Date(base.getTime() + offsetDays * DAY_MS);
    const [y, m, d] = fmt.format(ref).split("-").map(Number);
    const utcGuess = new Date(Date.UTC(y, m - 1, d));
    const tzDate = new Date(utcGuess.toLocaleString("en-US", { timeZone: tz }));
    const offset = tzDate.getTime() - utcGuess.getTime();
    return new Date(utcGuess.getTime() - offset);
  } catch {
    const local = new Date(base.getTime() + offsetDays * DAY_MS);
    local.setHours(0, 0, 0, 0);
    return local;
  }
}

/** Día de la semana (0-6) de un instante, en la TZ del negocio. */
export function weekdayInTz(date: Date, tz: string): number {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(date);
    const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return map[name] ?? date.getUTCDay();
  } catch {
    return date.getDay();
  }
}

/** Etiqueta legible de un instante en la TZ del negocio ("mar 5 ago, 10:00"). */
export function formatSlotLabel(date: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("es-PE", {
      timeZone: tz,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/** Normaliza el JSON de horario de atención; vacío = negocio sin agenda configurada. */
export function parseBusinessHours(value: unknown): BusinessHourRange[] {
  if (!Array.isArray(value)) return [];
  const out: BusinessHourRange[] = [];
  for (const raw of value) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const day = Number(r.day);
    const from = String(r.from ?? "");
    const to = String(r.to ?? "");
    if (!Number.isInteger(day) || day < 0 || day > 6) continue;
    if (!/^\d{1,2}:\d{2}$/.test(from) || !/^\d{1,2}:\d{2}$/.test(to)) continue;
    if (minutesOf(from) >= minutesOf(to)) continue; // franja inválida o nocturna (no soportada)
    out.push({ day, from, to });
  }
  return out;
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export interface ServiceBookingSettings {
  durationMin: number;
  slotCapacity: number;
  leadMinutes: number;
  horizonDays: number;
}

/** Config efectiva del servicio (con defaults sensatos). */
export function bookingSettingsOf(product: {
  durationMin?: number | null;
  slotCapacity?: number | null;
  bookingLeadMinutes?: number | null;
  bookingHorizonDays?: number | null;
}): ServiceBookingSettings {
  return {
    durationMin: product.durationMin && product.durationMin > 0 ? product.durationMin : DEFAULT_DURATION_MIN,
    slotCapacity: product.slotCapacity && product.slotCapacity > 0 ? product.slotCapacity : 1,
    leadMinutes: product.bookingLeadMinutes && product.bookingLeadMinutes > 0 ? product.bookingLeadMinutes : 0,
    horizonDays: Math.min(
      MAX_HORIZON_DAYS,
      product.bookingHorizonDays && product.bookingHorizonDays > 0 ? product.bookingHorizonDays : DEFAULT_HORIZON_DAYS,
    ),
  };
}

interface AvailabilityContext {
  timezone: string;
  hours: BusinessHourRange[];
  settings: ServiceBookingSettings;
  /** Citas vivas del rango (para contar ocupación por slot). */
  busy: Array<{ startsAt: Date; endsAt: Date }>;
  blocks: Array<{ startsAt: Date; endsAt: Date }>;
}

async function loadContext(
  companyId: string,
  productId: string,
  from: Date,
  to: Date,
): Promise<AvailabilityContext> {
  const [company, product] = await Promise.all([
    prisma.company.findUnique({
      where: { id: companyId },
      select: { timezone: true, businessHours: true },
    }),
    prisma.product.findFirst({
      where: { id: productId, companyId, active: true },
      select: {
        id: true,
        durationMin: true,
        slotCapacity: true,
        bookingLeadMinutes: true,
        bookingHorizonDays: true,
      },
    }),
  ]);
  if (!company) throw new AppError("Empresa no encontrada", 404);
  if (!product) throw new AppError("Servicio no encontrado o inactivo", 404);

  const [busy, blocks] = await Promise.all([
    prisma.serviceBooking.findMany({
      where: {
        companyId,
        productId,
        status: { in: ["SOLICITADA", "CONFIRMADA"] },
        startsAt: { not: null, gte: new Date(from.getTime() - DAY_MS), lte: new Date(to.getTime() + DAY_MS) },
      },
      select: { startsAt: true, endsAt: true },
    }),
    prisma.scheduleBlock.findMany({
      where: { companyId, endsAt: { gte: from }, startsAt: { lte: to } },
      select: { startsAt: true, endsAt: true },
    }),
  ]);

  const settings = bookingSettingsOf(product);
  return {
    timezone: company.timezone || "America/Lima",
    hours: parseBusinessHours(company.businessHours),
    settings,
    busy: busy
      .filter((b) => b.startsAt)
      .map((b) => ({
        startsAt: b.startsAt as Date,
        endsAt: b.endsAt ?? new Date((b.startsAt as Date).getTime() + settings.durationMin * 60_000),
      })),
    blocks,
  };
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Slots libres de un servicio entre dos fechas (por defecto, desde ahora hasta
 * el horizonte configurado). `limit` acota cuántos se devuelven (el agente
 * ofrece pocos).
 */
export async function getAvailableSlots(
  companyId: string,
  productId: string,
  opts: { from?: Date; to?: Date; limit?: number } = {},
): Promise<{ slots: Slot[]; timezone: string; durationMin: number; configured: boolean }> {
  const now = new Date();
  const from = opts.from && opts.from > now ? opts.from : now;
  const ctxTo = opts.to;
  const preCtx = await loadContext(companyId, productId, from, ctxTo ?? new Date(from.getTime() + 7 * DAY_MS));
  const { timezone, hours, settings, busy, blocks } = preCtx;

  const horizonEnd = new Date(startOfDayInTz(timezone, settings.horizonDays, now).getTime() + DAY_MS);
  const to = ctxTo && ctxTo < horizonEnd ? ctxTo : horizonEnd;
  const earliest = new Date(now.getTime() + settings.leadMinutes * 60_000);

  if (!hours.length) {
    return { slots: [], timezone, durationMin: settings.durationMin, configured: false };
  }

  const slots: Slot[] = [];
  const limit = opts.limit ?? 60;
  const durationMs = settings.durationMin * 60_000;

  for (let dayOffset = 0; dayOffset <= settings.horizonDays && slots.length < limit; dayOffset++) {
    const dayStart = startOfDayInTz(timezone, dayOffset, now);
    if (dayStart.getTime() > to.getTime()) break;
    const weekday = weekdayInTz(new Date(dayStart.getTime() + 12 * 3_600_000), timezone);
    const ranges = hours.filter((h) => h.day === weekday);

    for (const range of ranges) {
      const rangeStart = new Date(dayStart.getTime() + minutesOf(range.from) * 60_000);
      const rangeEnd = new Date(dayStart.getTime() + minutesOf(range.to) * 60_000);

      for (let t = rangeStart.getTime(); t + durationMs <= rangeEnd.getTime(); t += durationMs) {
        if (slots.length >= limit) break;
        const slotStart = new Date(t);
        const slotEnd = new Date(t + durationMs);
        if (slotStart < earliest || slotStart < from || slotStart > to) continue;
        if (blocks.some((b) => overlaps(slotStart, slotEnd, b.startsAt, b.endsAt))) continue;
        const taken = busy.filter((b) => overlaps(slotStart, slotEnd, b.startsAt, b.endsAt)).length;
        if (taken >= settings.slotCapacity) continue;
        slots.push({
          startsAt: slotStart.toISOString(),
          endsAt: slotEnd.toISOString(),
          label: formatSlotLabel(slotStart, timezone),
        });
      }
    }
  }

  return { slots, timezone, durationMin: settings.durationMin, configured: true };
}

/**
 * ¿El horario exacto sigue libre? (revalidación antes de confirmar, evita la
 * doble reserva por carrera entre la propuesta y la confirmación).
 */
export async function isSlotAvailable(
  companyId: string,
  productId: string,
  startsAt: Date,
  opts: { ignoreBookingId?: string } = {},
): Promise<{ ok: boolean; reason?: string; endsAt: Date; timezone: string; durationMin: number }> {
  const ctx = await loadContext(companyId, productId, startsAt, new Date(startsAt.getTime() + DAY_MS));
  const { timezone, hours, settings, blocks } = ctx;
  const endsAt = new Date(startsAt.getTime() + settings.durationMin * 60_000);
  const now = new Date();

  if (startsAt.getTime() < now.getTime() + settings.leadMinutes * 60_000) {
    return { ok: false, reason: "too-soon", endsAt, timezone, durationMin: settings.durationMin };
  }
  const horizonEnd = new Date(startOfDayInTz(timezone, settings.horizonDays, now).getTime() + DAY_MS);
  if (startsAt > horizonEnd) {
    return { ok: false, reason: "too-far", endsAt, timezone, durationMin: settings.durationMin };
  }
  if (!hours.length) {
    return { ok: false, reason: "no-schedule", endsAt, timezone, durationMin: settings.durationMin };
  }

  // Dentro del horario de atención del día
  const dayStart = startOfDayInTz(timezone, 0, startsAt);
  const weekday = weekdayInTz(new Date(dayStart.getTime() + 12 * 3_600_000), timezone);
  const inHours = hours
    .filter((h) => h.day === weekday)
    .some((h) => {
      const rs = dayStart.getTime() + minutesOf(h.from) * 60_000;
      const re = dayStart.getTime() + minutesOf(h.to) * 60_000;
      return startsAt.getTime() >= rs && endsAt.getTime() <= re;
    });
  if (!inHours) {
    return { ok: false, reason: "outside-hours", endsAt, timezone, durationMin: settings.durationMin };
  }
  if (blocks.some((b) => overlaps(startsAt, endsAt, b.startsAt, b.endsAt))) {
    return { ok: false, reason: "blocked", endsAt, timezone, durationMin: settings.durationMin };
  }

  // Capacidad del slot (excluyendo la propia cita si se está reagendando)
  const busy = await prisma.serviceBooking.count({
    where: {
      companyId,
      productId,
      status: { in: ["SOLICITADA", "CONFIRMADA"] },
      ...(opts.ignoreBookingId ? { id: { not: opts.ignoreBookingId } } : {}),
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
    },
  });
  if (busy >= settings.slotCapacity) {
    return { ok: false, reason: "taken", endsAt, timezone, durationMin: settings.durationMin };
  }

  return { ok: true, endsAt, timezone, durationMin: settings.durationMin };
}
