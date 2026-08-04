/**
 * Widget de reservas: rutas del panel (config) y rutas PÚBLICAS que consume el
 * widget embebido en la web del tenant. Las públicas no llevan billingGuard —
 * el gate (plan bloqueado, dominio, cupo de leads) se aplica en el servicio —
 * y sí llevan rate limiting: cada reserva crea un lead.
 */

import { Router } from "express";
import { validate } from "../../middlewares/validate";
import { makeRateLimiter } from "../../middlewares/rate-limit.middleware";
import {
  getConfigController,
  publicAvailabilityController,
  publicBookController,
  publicCancelController,
  publicMetaController,
  regenerateTokenController,
  updateConfigController,
} from "./booking-widget.controller";
import { updateBookingWidgetSchema, widgetBookSchema, widgetCancelSchema } from "./booking-widget.schemas";

/** Config del widget (panel del tenant, con JWT). */
export const bookingWidgetConfigRoutes = Router();

bookingWidgetConfigRoutes.get("/", getConfigController);
bookingWidgetConfigRoutes.put("/", validate({ body: updateBookingWidgetSchema }), updateConfigController);
bookingWidgetConfigRoutes.post("/regenerate", regenerateTokenController);

/** Endpoints públicos que consume el widget. */
export const bookingWidgetPublicRoutes = Router();

const readLimiter = makeRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: "Demasiadas solicitudes. Espera un momento.",
});

const bookLimiter = makeRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: "Demasiadas reservas desde esta conexión. Intenta más tarde.",
});

bookingWidgetPublicRoutes.get("/meta", readLimiter, publicMetaController);
bookingWidgetPublicRoutes.get("/availability", readLimiter, publicAvailabilityController);
bookingWidgetPublicRoutes.post("/book", bookLimiter, validate({ body: widgetBookSchema }), publicBookController);
bookingWidgetPublicRoutes.post("/cancel", bookLimiter, validate({ body: widgetCancelSchema }), publicCancelController);
