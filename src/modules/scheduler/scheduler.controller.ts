/**
 * Endpoints del panel para ver/cancelar recordatorios PROGRAMADOS (ScheduledMessage
 * PENDING de seguimiento). Lectura, edición del contenido y cancelación; el worker es quien envía.
 */

import { Request, Response } from "express";
import { ScheduledMessageType } from "@prisma/client";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/app-error";
import {
  listPendingReminders,
  cancelReminderById,
  cancelPendingReminders,
  cancelRemindersByIds,
  updateScheduledReminder,
  FOLLOWUP_TYPES,
  LISTABLE_TYPES,
} from "./scheduler.service";

/** GET /agent/reminders?type=&q=&productId=&late=1&offset=&limit= → página de recordatorios pendientes. */
export const listRemindersController = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  const typeRaw = String(req.query.type ?? "").toUpperCase();
  const type = (LISTABLE_TYPES as string[]).includes(typeRaw)
    ? (typeRaw as ScheduledMessageType)
    : undefined;
  const q = String(req.query.q ?? "");
  const productId = String(req.query.productId ?? "");
  const lateOnly = ["1", "true"].includes(String(req.query.late ?? ""));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  const page = await listPendingReminders(companyId, { type, q, productId, lateOnly, offset, limit });
  // `data` es la página; total/porTipo/atrasados son el conteo REAL con el filtro.
  res.json({ success: true, data: page.items, total: page.total, offset: page.offset, limit: page.limit, porTipo: page.porTipo, atrasados: page.atrasados });
});

/** PATCH /agent/reminders/:id { body?, mediaUrl?, mediaType?, sendAt? } → edita un recordatorio pendiente. */
export const updateReminderController = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  const b = (req.body ?? {}) as { body?: string; mediaUrl?: string | null; mediaType?: string | null; sendAt?: string };
  const data = await updateScheduledReminder(companyId, String(req.params.id), {
    ...(b.body !== undefined ? { body: b.body } : {}),
    ...(b.mediaUrl !== undefined ? { mediaUrl: b.mediaUrl } : {}),
    ...(b.mediaType !== undefined ? { mediaType: b.mediaType } : {}),
    ...(b.sendAt !== undefined ? { sendAt: new Date(b.sendAt) } : {}),
  });
  res.json({ success: true, data });
});

/** POST /agent/reminders/cancel-bulk { ids: string[] } → cancela en lote los seleccionados. */
export const cancelRemindersBulkController = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  const ids = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).map(String) : [];
  if (!ids.length) throw new AppError("No se enviaron recordatorios a cancelar", 400);
  const count = await cancelRemindersByIds(companyId, ids);
  res.json({ success: true, count });
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
