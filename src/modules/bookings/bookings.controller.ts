import { Request, Response } from "express";
import { ServiceBookingStatus } from "@prisma/client";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/app-error";
import {
  createBooking,
  createScheduleBlock,
  deleteBooking,
  deleteScheduleBlock,
  getAvailableSlots,
  listBookings,
  listScheduleBlocks,
  rescheduleBooking,
  updateBookingStatus,
} from "./bookings.service";

const VALID_STATUSES: ServiceBookingStatus[] = ["SOLICITADA", "CONFIRMADA", "CANCELADA", "COMPLETADA"];

function parseDate(value: unknown): Date | undefined {
  if (!value) return undefined;
  const d = new Date(String(value));
  return isNaN(d.getTime()) ? undefined : d;
}

export const listBookingsController = asyncHandler(async (req: Request, res: Response) => {
  const status = String(req.query.status ?? "") as ServiceBookingStatus;
  const bookings = await listBookings(req.user!.companyId, {
    ...(VALID_STATUSES.includes(status) ? { status } : {}),
    from: parseDate(req.query.from),
    to: parseDate(req.query.to),
    scheduledOnly: req.query.scheduledOnly === "1",
  });
  res.json({ success: true, data: bookings });
});

export const availabilityController = asyncHandler(async (req: Request, res: Response) => {
  const productId = String(req.query.productId ?? "");
  if (!productId) throw new AppError("Falta el servicio", 400);
  const result = await getAvailableSlots(req.user!.companyId, productId, {
    from: parseDate(req.query.from),
    to: parseDate(req.query.to),
    limit: Math.min(200, Number(req.query.limit ?? 60) || 60),
  });
  res.json({ success: true, data: result });
});

/** Alta manual desde el panel (el dueño agenda por teléfono, por ejemplo). */
export const createBookingController = asyncHandler(async (req: Request, res: Response) => {
  const { customerId, productId, startsAt, requestedText, modality, notes } = req.body ?? {};
  if (!customerId || !productId) throw new AppError("Falta el cliente o el servicio", 400);
  const booking = await createBooking({
    companyId: req.user!.companyId,
    customerId: String(customerId),
    productId: String(productId),
    startsAt: startsAt ? String(startsAt) : null,
    requestedText: requestedText ? String(requestedText) : null,
    modality: modality ? String(modality) : null,
    notes: notes ? String(notes) : null,
    source: "manual",
  });
  res.status(201).json({ success: true, data: booking });
});

export const updateBookingStatusController = asyncHandler(async (req: Request, res: Response) => {
  const status = String(req.body?.status ?? "") as ServiceBookingStatus;
  if (!VALID_STATUSES.includes(status)) throw new AppError("Estado de reserva inválido", 400);
  const updated = await updateBookingStatus(req.user!.companyId, String(req.params.id), status);
  res.json({ success: true, data: updated });
});

export const rescheduleBookingController = asyncHandler(async (req: Request, res: Response) => {
  const startsAt = String(req.body?.startsAt ?? "");
  if (!startsAt) throw new AppError("Falta la nueva fecha", 400);
  const updated = await rescheduleBooking(req.user!.companyId, String(req.params.id), startsAt);
  res.json({ success: true, data: updated });
});

export const deleteBookingController = asyncHandler(async (req: Request, res: Response) => {
  await deleteBooking(req.user!.companyId, String(req.params.id));
  res.status(204).send();
});

// --- Bloqueos de agenda ---

export const listBlocksController = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await listScheduleBlocks(req.user!.companyId) });
});

export const createBlockController = asyncHandler(async (req: Request, res: Response) => {
  const { startsAt, endsAt, reason } = req.body ?? {};
  const block = await createScheduleBlock(req.user!.companyId, {
    startsAt: String(startsAt ?? ""),
    endsAt: String(endsAt ?? ""),
    reason: reason ? String(reason) : null,
  });
  res.status(201).json({ success: true, data: block });
});

export const deleteBlockController = asyncHandler(async (req: Request, res: Response) => {
  await deleteScheduleBlock(req.user!.companyId, String(req.params.id));
  res.status(204).send();
});
