/** Rutas PÚBLICAS de la tienda web (/api/public/store): sin JWT, con rate limit. */

import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { validate } from "../../middlewares/validate";
import { makeRateLimiter } from "../../middlewares/rate-limit.middleware";
import { storeCheckoutSchema, storeOrderParamsSchema, storeOrderQuerySchema, storeSlugParamsSchema } from "./storefront.schemas";
import {
  getPublicOrderController,
  getPublicStoreController,
  storeCheckoutController,
  tlsAskController,
} from "./storefront.controller";

const router = Router();

const catalogLimiter = makeRateLimiter({ windowMs: 15 * 60_000, max: 240, message: "Demasiadas solicitudes, intenta en unos minutos." });
const checkoutLimiter = makeRateLimiter({ windowMs: 15 * 60_000, max: 10, message: "Demasiados intentos de compra, intenta en unos minutos." });
const orderLimiter = makeRateLimiter({ windowMs: 5 * 60_000, max: 120, message: "Demasiadas consultas, intenta en un momento." });

// Caddy on_demand_tls `ask`: ¿este subdominio tiene tienda activa?
router.get("/tls-ask", asyncHandler(tlsAskController));
router.get("/order/:id", orderLimiter, validate({ params: storeOrderParamsSchema, query: storeOrderQuerySchema }), asyncHandler(getPublicOrderController));
router.get("/:slug", catalogLimiter, validate({ params: storeSlugParamsSchema }), asyncHandler(getPublicStoreController));
router.post("/:slug/checkout", checkoutLimiter, validate({ params: storeSlugParamsSchema, body: storeCheckoutSchema }), asyncHandler(storeCheckoutController));

export default router;
