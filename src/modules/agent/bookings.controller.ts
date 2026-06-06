import { Request, Response } from "express";
import { ServiceBookingStatus } from "@prisma/client";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/app-error";
import { listBookings, updateBookingStatus } from "./booking.service";

export const listBookingsController = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  const bookings = await listBookings(companyId);
  res.json({ success: true, data: bookings });
});

const VALID_STATUSES: ServiceBookingStatus[] = ["SOLICITADA", "CONFIRMADA", "CANCELADA", "COMPLETADA"];

export const updateBookingStatusController = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  const status = String(req.body?.status ?? "") as ServiceBookingStatus;
  if (!VALID_STATUSES.includes(status)) {
    throw new AppError("Estado de reserva inválido", 400);
  }
  const updated = await updateBookingStatus(companyId, String(req.params.id), status);
  res.json({ success: true, data: updated });
});
