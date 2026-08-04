import { Request, Response } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/app-error";
import {
  bookFromWidget,
  cancelFromWidget,
  getBookingWidgetAvailability,
  getBookingWidgetConfig,
  getBookingWidgetMeta,
  regenerateBookingWidgetToken,
  updateBookingWidgetConfig,
} from "./booking-widget.service";

// --- Panel del tenant ---

export const getConfigController = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await getBookingWidgetConfig(req.user!.companyId) });
});

export const updateConfigController = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await updateBookingWidgetConfig(req.user!.companyId, req.body) });
});

export const regenerateTokenController = asyncHandler(async (req: Request, res: Response) => {
  res.json({ success: true, data: await regenerateBookingWidgetToken(req.user!.companyId) });
});

// --- Público (widget embebido en la web del tenant) ---

/** El origin de la página anfitriona lo manda el iframe; el header Origin es el fallback. */
function originOf(req: Request): string | undefined {
  const fromQuery = typeof req.query.origin === "string" ? req.query.origin : undefined;
  const fromBody = typeof req.body?.parentOrigin === "string" ? req.body.parentOrigin : undefined;
  return fromQuery || fromBody || req.get("origin") || undefined;
}

export const publicMetaController = asyncHandler(async (req: Request, res: Response) => {
  const token = String(req.query.token ?? "");
  if (!token) throw new AppError("Token requerido", 400);
  res.json({ success: true, data: await getBookingWidgetMeta(token, originOf(req)) });
});

export const publicAvailabilityController = asyncHandler(async (req: Request, res: Response) => {
  const token = String(req.query.token ?? "");
  const productId = String(req.query.productId ?? "");
  if (!token || !productId) throw new AppError("Faltan datos para consultar disponibilidad", 400);
  const data = await getBookingWidgetAvailability({
    token,
    productId,
    from: req.query.from ? String(req.query.from) : undefined,
    to: req.query.to ? String(req.query.to) : undefined,
    parentOrigin: originOf(req),
  });
  res.json({ success: true, data });
});

export const publicBookController = asyncHandler(async (req: Request, res: Response) => {
  const data = await bookFromWidget({ ...req.body, parentOrigin: originOf(req) });
  res.status(201).json({ success: true, data });
});

export const publicCancelController = asyncHandler(async (req: Request, res: Response) => {
  const data = await cancelFromWidget({ ...req.body, parentOrigin: originOf(req) });
  res.json({ success: true, data });
});
