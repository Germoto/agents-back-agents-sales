/**
 * Reservas de servicios (rubro SERVICE). El agente registra una reserva ligera
 * (horario solicitado como texto); el admin la confirma/coordina desde el panel.
 */

import { ServiceBookingStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { socketService, SOCKET_EVENTS } from "../../lib/socket";

export async function createBooking(input: {
  companyId: string;
  customerId: string;
  productId: string;
  requestedText: string;
  modality?: string | null;
  notes?: string | null;
}) {
  const product = await prisma.product.findFirst({
    where: { id: input.productId, companyId: input.companyId, active: true },
    select: { id: true, name: true },
  });
  if (!product) throw new AppError("Servicio no encontrado o inactivo", 404);

  const booking = await prisma.serviceBooking.create({
    data: {
      companyId: input.companyId,
      customerId: input.customerId,
      productId: input.productId,
      requestedText: input.requestedText.trim(),
      modality: input.modality?.trim() || null,
      notes: input.notes?.trim() || null,
      status: "SOLICITADA",
    },
    include: { product: { select: { name: true } } },
  });

  socketService.emitToCompany(input.companyId, SOCKET_EVENTS.BOOKING_NEW, {
    id: booking.id,
    status: booking.status,
    requestedText: booking.requestedText,
    service: booking.product?.name,
  });

  return booking;
}

export async function listBookings(companyId: string) {
  return prisma.serviceBooking.findMany({
    where: { companyId },
    include: {
      customer: { select: { id: true, phone: true, name: true } },
      product: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function updateBookingStatus(companyId: string, id: string, status: ServiceBookingStatus) {
  const existing = await prisma.serviceBooking.findFirst({ where: { id, companyId }, select: { id: true } });
  if (!existing) throw new AppError("Reserva no encontrada", 404);
  return prisma.serviceBooking.update({ where: { id }, data: { status } });
}
