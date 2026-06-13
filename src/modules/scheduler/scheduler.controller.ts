/**
 * Endpoints del panel para ver/cancelar recordatorios PROGRAMADOS (ScheduledMessage
 * PENDING de seguimiento). Solo lectura + cancelación; el worker es quien envía.
 */

import { Request, Response } from "express";
import { ScheduledMessageType } from "@prisma/client";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/app-error";
import {
  listPendingReminders,
  cancelReminderById,
  cancelPendingReminders,
  FOLLOWUP_TYPES,
} from "./scheduler.service";

/** GET /agent/reminders?type=&q= → lista de recordatorios de seguimiento pendientes. */
export const listRemindersController = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  const typeRaw = String(req.query.type ?? "").toUpperCase();
  const type = (FOLLOWUP_TYPES as string[]).includes(typeRaw)
    ? (typeRaw as ScheduledMessageType)
    : undefined;
  const q = String(req.query.q ?? "");
  const reminders = await listPendingReminders(companyId, { type, q });
  res.json({ success: true, data: reminders });
});

/** POST /agent/reminders/:id/cancel → cancela un recordatorio puntual. */
export const cancelReminderController = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  const ok = await cancelReminderById(companyId, String(req.params.id));
  if (!ok) throw new AppError("El recordatorio no existe o ya no está pendiente", 404);
  res.json({ success: true });
});

/** POST /agent/reminders/cancel { customerId } → cancela todos los pendientes de un cliente. */
export const cancelClientRemindersController = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  const customerId = String(req.body?.customerId ?? "").trim();
  if (!customerId) throw new AppError("Falta customerId", 400);
  await cancelPendingReminders(companyId, customerId, FOLLOWUP_TYPES);
  res.json({ success: true });
});
