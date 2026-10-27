/**
 * Rutas PÚBLICAS de calendario (sin JWT, sin billingGuard):
 *  - /cita/:code.ics?t=   → .ics de una cita (el cliente lo abre en iPhone/Outlook)
 *  - /cita/:code/google?t= → 302 a Google Calendar con el evento prellenado
 *  - /feed/:token.ics      → calendario suscrito del dueño (citas + bloqueos)
 * `t` es el cancelToken de la cita; el token del feed es secreto por empresa.
 */

import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/app-error";
import { makeRateLimiter } from "../../middlewares/rate-limit.middleware";
import { assertFeedToken, bookingIcs, buildCompanyFeed, googleCalendarUrl, loadPublicBooking } from "./calendar.service";

export const calendarPublicRoutes = Router();

const limiter = makeRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: "Demasiadas solicitudes. Espera un momento.",
});
calendarPublicRoutes.use(limiter);

function stripIcs(param: string): string {
  return decodeURIComponent(param).replace(/\.ics$/i, "");
}

calendarPublicRoutes.get(
  "/cita/:code.ics",
  asyncHandler(async (req: Request, res: Response) => {
    const b = await loadPublicBooking(stripIcs(String(req.params.code)), String(req.query.t ?? ""));
    if (!b || !b.startsAt) throw new AppError("Cita no encontrada", 404);
    const ics = bookingIcs(b, { name: b.company.name, timezone: b.company.timezone || "America/Lima", meetingUrl: b.company.meetingUrl });
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="cita-${b.bookingCode ?? "flowapp"}.ics"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(ics);
  }),
);

calendarPublicRoutes.get(
  "/cita/:code/google",
  asyncHandler(async (req: Request, res: Response) => {
    const b = await loadPublicBooking(String(req.params.code), String(req.query.t ?? ""));
    if (!b || !b.startsAt) throw new AppError("Cita no encontrada", 404);
    res.redirect(302, googleCalendarUrl(b, { name: b.company.name, timezone: b.company.timezone || "America/Lima", meetingUrl: b.company.meetingUrl }));
  }),
);

calendarPublicRoutes.get(
  "/feed/:token.ics",
  asyncHandler(async (req: Request, res: Response) => {
    const token = stripIcs(String(req.params.token));
    assertFeedToken(token);
    const ics = await buildCompanyFeed(token);
    if (!ics) throw new AppError("Calendario no encontrado", 404);
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(ics);
  }),
);
