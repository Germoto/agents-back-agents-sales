/**
 * Agenda de citas (rubro SERVICE): crear, reagendar, cancelar y consultar.
 *
 * Reemplaza al antiguo booking.service (reserva "en texto libre"): ahora una
 * cita tiene fecha/hora reales validadas contra el motor de disponibilidad, un
 * código legible y recordatorios automáticos al cliente.
 *
 * Compatibilidad: si no se pasa `startsAt` (el cliente no fijó hora), la
 * reserva se guarda como SOLICITADA con `requestedText`, igual que antes.
 */

import crypto from "crypto";
import { ServiceBookingStatus, ScheduledMessageStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { socketService, SOCKET_EVENTS } from "../../lib/socket";
import { isSlotAvailable, formatSlotLabel, getAvailableSlots } from "./availability.service";

/** Horas antes de la cita en que se avisa al cliente (config futura por tenant). */
const REMINDER_HOURS = [24, 2];

function buildBookingCode(seed: number): string {
  const t = seed.toString(36).toUpperCase().slice(-6);
  const r = Math.floor((seed % 1000) + (seed % 97)).toString(36).toUpperCase().slice(-2);
  return `CITA-${t}${r}`;
}

const bookingInclude = {
  customer: { select: { id: true, phone: true, name: true, avatarUrl: true } },
  product: { select: { id: true, name: true } },
} as const;

// ---------------------------------------------------------------------------
// Recordatorios de cita
// ---------------------------------------------------------------------------

/**
 * Programa los recordatorios de una cita (24 h y 2 h antes por defecto).
 * OJO: se crean con prisma directo (no `scheduleReminder`) a propósito — el
 * helper clampea el sendAt al horario hábil y una cita debe recordarse a SU
 * hora. El worker exime BOOKING_REMINDER de esos guards.
 */
export async function scheduleBookingReminders(bookingId: string): Promise<void> {
  const booking = await prisma.serviceBooking.findUnique({
    where: { id: bookingId },
    include: {
      ...bookingInclude,
      company: { select: { timezone: true, name: true } },
      product: { select: { id: true, name: true, verticalData: true } },
    },
  });
  if (!booking?.startsAt) return;
  if (booking.status === "CANCELADA" || booking.status === "COMPLETADA") return;

  const tz = booking.company.timezone || "America/Lima";
  const when = formatSlotLabel(booking.startsAt, tz);
  // Lugar de la cita/visita (pack inmobiliario u otro rubro que lo configure).
  const vd = (booking.product.verticalData ?? {}) as Record<string, unknown>;
  const location = String(vd.location ?? vd.address ?? "").trim();
  const locationLine = location ? `\n📍 ${location}` : "";
  const conversation = await prisma.conversation.findFirst({
    where: { companyId: booking.companyId, customerId: booking.customerId, channel: { in: ["whatsapp", "web"] } },
    orderBy: { lastMessageAt: "desc" },
    select: { id: true },
  });

  const now = Date.now();
  for (const hours of REMINDER_HOURS) {
    const sendAt = new Date(booking.startsAt.getTime() - hours * 3_600_000);
    if (sendAt.getTime() <= now) continue; // ya pasó ese punto
    const body =
      hours >= 24
        ? `👋 Hola${booking.customer.name ? ` ${booking.customer.name}` : ""}, te recordamos tu cita de *${booking.product.name}* para mañana: ${when}.${locationLine}\nSi necesitas cambiarla, escríbenos por aquí.`
        : `⏰ Tu cita de *${booking.product.name}* es hoy a las ${when.split(", ").pop()}. ¡Te esperamos!${locationLine}`;
    await prisma.scheduledMessage.create({
      data: {
        companyId: booking.companyId,
        customerId: booking.customerId,
        conversationId: conversation?.id ?? null,
        type: "BOOKING_REMINDER",
        sendAt,
        body,
        metadata: { bookingId: booking.id, hoursBefore: hours },
      },
    });
  }
}

/** Cancela los recordatorios pendientes de una cita (al reagendar o cancelar). */
export async function cancelBookingReminders(bookingId: string): Promise<void> {
  await prisma.scheduledMessage
    .updateMany({
      where: {
        type: "BOOKING_REMINDER",
        status: ScheduledMessageStatus.PENDING,
        metadata: { path: ["bookingId"], equals: bookingId },
      },
      data: { status: ScheduledMessageStatus.CANCELLED, failureReason: "cita reagendada o cancelada" },
    })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// CRUD de citas
// ---------------------------------------------------------------------------

export interface CreateBookingInput {
  companyId: string;
  customerId: string;
  productId: string;
  /** Horario tal como lo dijo el cliente (respaldo si no hay fecha exacta). */
  requestedText?: string | null;
  /** Fecha/hora exacta (ISO). Con esto la cita entra a la agenda real. */
  startsAt?: string | Date | null;
  modality?: string | null;
  notes?: string | null;
  source?: string;
}

export async function createBooking(input: CreateBookingInput) {
  const product = await prisma.product.findFirst({
    where: { id: input.productId, companyId: input.companyId, active: true },
    select: { id: true, name: true },
  });
  if (!product) throw new AppError("Servicio no encontrado o inactivo", 404);

  let startsAt: Date | null = null;
  let endsAt: Date | null = null;
  let durationMin: number | null = null;

  if (input.startsAt) {
    const parsed = input.startsAt instanceof Date ? input.startsAt : new Date(input.startsAt);
    if (isNaN(parsed.getTime())) throw new AppError("Fecha de la cita inválida", 400);
    const check = await isSlotAvailable(input.companyId, product.id, parsed);
    if (!check.ok) {
      throw new AppError(reasonMessage(check.reason), 409, { code: "SLOT_UNAVAILABLE", reason: check.reason });
    }
    startsAt = parsed;
    endsAt = check.endsAt;
    durationMin = check.durationMin;
  }

  const booking = await prisma.serviceBooking.create({
    data: {
      companyId: input.companyId,
      customerId: input.customerId,
      productId: product.id,
      requestedText: (input.requestedText ?? "").trim() || (startsAt ? "cita agendada" : ""),
      modality: input.modality?.trim() || null,
      notes: input.notes?.trim() || null,
      status: startsAt ? "CONFIRMADA" : "SOLICITADA",
      startsAt,
      endsAt,
      durationMin,
      bookingCode: buildBookingCode(Date.now()),
      source: input.source ?? "agent",
      cancelToken: crypto.randomBytes(12).toString("hex"),
    },
    include: bookingInclude,
  });

  if (startsAt) await scheduleBookingReminders(booking.id);

  socketService.emitToCompany(input.companyId, SOCKET_EVENTS.BOOKING_NEW, {
    id: booking.id,
    status: booking.status,
    startsAt: booking.startsAt,
    requestedText: booking.requestedText,
    service: booking.product?.name,
  });

  return booking;
}

export function reasonMessage(reason?: string): string {
  switch (reason) {
    case "taken":
      return "Ese horario ya está ocupado";
    case "outside-hours":
      return "Ese horario está fuera del horario de atención";
    case "too-soon":
      return "Ese horario es demasiado próximo para reservar";
    case "too-far":
      return "Ese horario excede el plazo de reserva permitido";
    case "blocked":
      return "Ese día está bloqueado en la agenda";
    case "no-schedule":
      return "El negocio aún no configuró su horario de atención";
    default:
      return "El horario no está disponible";
  }
}

export interface ListBookingsFilters {
  status?: ServiceBookingStatus;
  from?: Date;
  to?: Date;
  /** true = solo citas con fecha (agenda); false = todas. */
  scheduledOnly?: boolean;
}

export async function listBookings(companyId: string, filters: ListBookingsFilters = {}) {
  const rows = await prisma.serviceBooking.findMany({
    where: {
      companyId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.scheduledOnly ? { startsAt: { not: null } } : {}),
      ...(filters.from || filters.to
        ? {
            startsAt: {
              ...(filters.scheduledOnly ? { not: null } : {}),
              ...(filters.from ? { gte: filters.from } : {}),
              ...(filters.to ? { lte: filters.to } : {}),
            },
          }
        : {}),
    },
    include: bookingInclude,
    orderBy: [{ startsAt: "asc" }, { createdAt: "desc" }],
    take: 500,
  });
  return rows;
}

export async function updateBookingStatus(companyId: string, id: string, status: ServiceBookingStatus) {
  const existing = await prisma.serviceBooking.findFirst({ where: { id, companyId }, select: { id: true } });
  if (!existing) throw new AppError("Reserva no encontrada", 404);
  if (status === "CANCELADA" || status === "COMPLETADA") await cancelBookingReminders(id);
  const updated = await prisma.serviceBooking.update({
    where: { id },
    data: { status },
    include: bookingInclude,
  });
  socketService.emitToCompany(companyId, SOCKET_EVENTS.BOOKING_NEW, {
    id: updated.id,
    status: updated.status,
    startsAt: updated.startsAt,
    service: updated.product?.name,
  });
  return updated;
}

/** Reagenda una cita a un nuevo horario (revalida disponibilidad y reprograma avisos). */
export async function rescheduleBooking(companyId: string, id: string, startsAtIso: string) {
  const booking = await prisma.serviceBooking.findFirst({
    where: { id, companyId },
    select: { id: true, productId: true },
  });
  if (!booking) throw new AppError("Reserva no encontrada", 404);
  const startsAt = new Date(startsAtIso);
  if (isNaN(startsAt.getTime())) throw new AppError("Fecha de la cita inválida", 400);

  const check = await isSlotAvailable(companyId, booking.productId, startsAt, { ignoreBookingId: id });
  if (!check.ok) {
    throw new AppError(reasonMessage(check.reason), 409, { code: "SLOT_UNAVAILABLE", reason: check.reason });
  }

  await cancelBookingReminders(id);
  const updated = await prisma.serviceBooking.update({
    where: { id },
    data: {
      startsAt,
      endsAt: check.endsAt,
      durationMin: check.durationMin,
      status: "CONFIRMADA",
    },
    include: bookingInclude,
  });
  await scheduleBookingReminders(id);
  socketService.emitToCompany(companyId, SOCKET_EVENTS.BOOKING_NEW, {
    id: updated.id,
    status: updated.status,
    startsAt: updated.startsAt,
    service: updated.product?.name,
  });
  return updated;
}

export async function deleteBooking(companyId: string, id: string) {
  const existing = await prisma.serviceBooking.findFirst({ where: { id, companyId }, select: { id: true } });
  if (!existing) throw new AppError("Reserva no encontrada", 404);
  await cancelBookingReminders(id);
  await prisma.serviceBooking.delete({ where: { id } });
}

// ---------------------------------------------------------------------------
// Bloqueos de agenda (feriados / vacaciones)
// ---------------------------------------------------------------------------

export async function listScheduleBlocks(companyId: string) {
  return prisma.scheduleBlock.findMany({
    where: { companyId, endsAt: { gte: new Date(Date.now() - 30 * 24 * 3_600_000) } },
    orderBy: { startsAt: "asc" },
  });
}

export async function createScheduleBlock(
  companyId: string,
  data: { startsAt: string; endsAt: string; reason?: string | null },
) {
  const startsAt = new Date(data.startsAt);
  const endsAt = new Date(data.endsAt);
  if (isNaN(startsAt.getTime()) || isNaN(endsAt.getTime()) || endsAt <= startsAt) {
    throw new AppError("Rango de bloqueo inválido", 400);
  }
  return prisma.scheduleBlock.create({
    data: { companyId, startsAt, endsAt, reason: data.reason?.trim() || null },
  });
}

export async function deleteScheduleBlock(companyId: string, id: string) {
  const existing = await prisma.scheduleBlock.findFirst({ where: { id, companyId }, select: { id: true } });
  if (!existing) throw new AppError("Bloqueo no encontrado", 404);
  await prisma.scheduleBlock.delete({ where: { id } });
}

export { getAvailableSlots };
