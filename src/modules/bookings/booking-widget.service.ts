/**
 * Widget de reservas embebible: el tenant pega un snippet en SU web y sus
 * clientes agendan solos contra el mismo motor de disponibilidad que usa el
 * agente en el chat (mismo horario, mismos bloqueos, mismo cupo).
 *
 * Mismo patrón que el chat web: token público por empresa, dominios permitidos
 * validados en servidor, y gate de leads para no regalar contactos nuevos.
 * A diferencia del chat, aquí no hay sesión: cada llamada lleva el token.
 */

import crypto from "crypto";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { normalizePhone } from "../agent/conversation.service";
import { gateNewLead } from "../billing/billing.service";
import { getEntitlements } from "../billing/entitlements";
import { originAllowed } from "../webchat/webchat.service";
import { getAvailableSlots, formatSlotLabel, bookingSettingsOf } from "./availability.service";
import { createBooking, updateBookingStatus } from "./bookings.service";

export function newBookingWidgetToken(): string {
  return `bk_${crypto.randomBytes(16).toString("hex")}`;
}

export interface UpdateBookingWidgetInput {
  enabled?: boolean;
  allowedOrigins?: string[];
  headline?: string;
  accentColor?: string;
  successMessage?: string;
  productIds?: string[];
}

// ---------------------------------------------------------------------------
// Config del panel
// ---------------------------------------------------------------------------

export async function getBookingWidgetConfig(companyId: string) {
  const existing = await prisma.bookingWidgetConfig.findUnique({ where: { companyId } });
  const cfg =
    existing ??
    (await prisma.bookingWidgetConfig.create({
      data: { companyId, token: newBookingWidgetToken() },
    }));
  return {
    enabled: cfg.enabled,
    token: cfg.token,
    allowedOrigins: cfg.allowedOrigins,
    headline: cfg.headline,
    accentColor: cfg.accentColor,
    successMessage: cfg.successMessage,
    productIds: cfg.productIds,
  };
}

export async function updateBookingWidgetConfig(companyId: string, data: UpdateBookingWidgetInput) {
  await getBookingWidgetConfig(companyId); // crea la fila (con token) si no existe
  await prisma.bookingWidgetConfig.update({
    where: { companyId },
    data: {
      ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      ...(data.allowedOrigins !== undefined ? { allowedOrigins: data.allowedOrigins } : {}),
      ...(data.headline !== undefined ? { headline: data.headline } : {}),
      ...(data.accentColor !== undefined ? { accentColor: data.accentColor } : {}),
      ...(data.successMessage !== undefined ? { successMessage: data.successMessage } : {}),
      ...(data.productIds !== undefined ? { productIds: data.productIds } : {}),
    },
  });
  return getBookingWidgetConfig(companyId);
}

/** Regenera el token público: el snippet viejo deja de funcionar. */
export async function regenerateBookingWidgetToken(companyId: string) {
  await getBookingWidgetConfig(companyId);
  await prisma.bookingWidgetConfig.update({
    where: { companyId },
    data: { token: newBookingWidgetToken() },
  });
  return getBookingWidgetConfig(companyId);
}

// ---------------------------------------------------------------------------
// Público (widget en la web del tenant)
// ---------------------------------------------------------------------------

/** Resuelve el token a una empresa, validando activación, plan y dominio. */
async function resolveWidget(token: string, parentOrigin?: string) {
  const cfg = await prisma.bookingWidgetConfig.findUnique({
    where: { token },
    select: {
      companyId: true,
      enabled: true,
      allowedOrigins: true,
      headline: true,
      accentColor: true,
      successMessage: true,
      productIds: true,
      company: { select: { name: true, timezone: true } },
    },
  });
  if (!cfg || !cfg.enabled) throw new AppError("Reservas no disponibles", 404);
  if (!originAllowed(parentOrigin, cfg.allowedOrigins)) {
    throw new AppError("Dominio no autorizado para este widget", 403);
  }
  // Suscripción vencida = el widget deja de tomar reservas (el panel sigue).
  const ent = await getEntitlements(cfg.companyId);
  if (ent.blocked) throw new AppError("Reservas no disponibles", 404);
  return cfg;
}

/** Servicios que el widget puede ofrecer: activos, con duración y (si se filtró) elegidos. */
async function reservableProducts(companyId: string, productIds: string[]) {
  const products = await prisma.product.findMany({
    where: {
      companyId,
      active: true,
      ...(productIds.length ? { id: { in: productIds } } : {}),
    },
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      name: true,
      price: true,
      shortDescription: true,
      durationMin: true,
      slotCapacity: true,
      bookingLeadMinutes: true,
      bookingHorizonDays: true,
    },
  });
  // Sin duración no hay agenda posible: esos servicios no se ofrecen aquí.
  return products.filter((p) => (p.durationMin ?? 0) > 0);
}

export async function getBookingWidgetMeta(token: string, parentOrigin?: string) {
  const cfg = await resolveWidget(token, parentOrigin);
  const products = await reservableProducts(cfg.companyId, cfg.productIds);
  return {
    companyName: cfg.company.name,
    timezone: cfg.company.timezone,
    headline: cfg.headline,
    accentColor: cfg.accentColor,
    successMessage: cfg.successMessage,
    services: products.map((p) => ({
      id: p.id,
      name: p.name,
      price: p.price,
      description: p.shortDescription ?? "",
      durationMin: bookingSettingsOf(p).durationMin,
    })),
  };
}

export async function getBookingWidgetAvailability(params: {
  token: string;
  productId: string;
  from?: string;
  to?: string;
  parentOrigin?: string;
}) {
  const cfg = await resolveWidget(params.token, params.parentOrigin);
  const products = await reservableProducts(cfg.companyId, cfg.productIds);
  if (!products.some((p) => p.id === params.productId)) {
    throw new AppError("Servicio no disponible para reservar", 404);
  }
  const from = params.from ? new Date(params.from) : undefined;
  const to = params.to ? new Date(params.to) : undefined;
  const result = await getAvailableSlots(cfg.companyId, params.productId, {
    from: from && !isNaN(from.getTime()) ? from : undefined,
    to: to && !isNaN(to.getTime()) ? to : undefined,
    limit: 200,
  });
  return result;
}

export interface WidgetBookInput {
  token: string;
  productId: string;
  startsAt: string;
  name: string;
  phone: string;
  notes?: string;
  parentOrigin?: string;
}

export async function bookFromWidget(input: WidgetBookInput) {
  const cfg = await resolveWidget(input.token, input.parentOrigin);
  const companyId = cfg.companyId;

  const products = await reservableProducts(companyId, cfg.productIds);
  if (!products.some((p) => p.id === input.productId)) {
    throw new AppError("Servicio no disponible para reservar", 404);
  }

  const name = input.name.trim();
  if (name.length < 2) throw new AppError("Escribe tu nombre", 400);
  const digits = input.phone.replace(/\D/g, "");
  if (digits.length < 8) throw new AppError("El número de WhatsApp no es válido", 400);
  const phone = normalizePhone(digits);

  // Gate de leads: mismo criterio que el chat web y el inbound de WhatsApp
  // (solo los números NUEVOS consumen cupo del plan).
  const entitlements = await getEntitlements(companyId);
  const existing = await prisma.customer.findUnique({
    where: { companyId_phone: { companyId, phone } },
    select: { id: true, name: true },
  });
  if (!entitlements.legacy && !existing) {
    const allowed = await gateNewLead(companyId, phone);
    if (!allowed) throw new AppError("Reservas no disponibles por el momento", 503);
  }

  const customer = await prisma.customer.upsert({
    where: { companyId_phone: { companyId, phone } },
    update: {
      lastInteractionAt: new Date(),
      // El nombre manual del panel manda: solo se completa si estaba vacío.
      ...(existing?.name ? {} : { name }),
    },
    create: {
      companyId,
      phone,
      name,
      status: "activo",
      lastInteractionAt: new Date(),
      metadata: { origin: "booking-widget" },
    },
    select: { id: true },
  });

  const booking = await createBooking({
    companyId,
    customerId: customer.id,
    productId: input.productId,
    startsAt: input.startsAt,
    notes: input.notes?.trim() || null,
    source: "widget",
  });

  const tz = cfg.company.timezone || "America/Lima";
  return {
    bookingCode: booking.bookingCode,
    cancelToken: booking.cancelToken,
    startsAt: booking.startsAt,
    when: booking.startsAt ? formatSlotLabel(booking.startsAt, tz) : "",
    service: booking.product?.name ?? "",
    successMessage: cfg.successMessage,
  };
}

/** Cancelación desde el widget: exige el código + el token secreto de la cita. */
export async function cancelFromWidget(params: {
  token: string;
  bookingCode: string;
  cancelToken: string;
  parentOrigin?: string;
}) {
  const cfg = await resolveWidget(params.token, params.parentOrigin);
  const booking = await prisma.serviceBooking.findFirst({
    where: {
      companyId: cfg.companyId,
      bookingCode: params.bookingCode.trim().toUpperCase(),
      cancelToken: params.cancelToken,
    },
    select: { id: true, status: true },
  });
  if (!booking) throw new AppError("No encontramos esa reserva", 404);
  if (booking.status === "CANCELADA") return { ok: true };

  await updateBookingStatus(cfg.companyId, booking.id, "CANCELADA");
  return { ok: true };
}
