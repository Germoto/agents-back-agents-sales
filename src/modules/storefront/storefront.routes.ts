/** Rutas del PANEL para configurar la tienda web (/api/storefront). */

import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import { approveStoreOrderSchema, rejectStoreOrderSchema, storeMetricsQuerySchema, storeOrderParamsSchema, storeOrdersQuerySchema, updateStorefrontConfigSchema } from "./storefront.schemas";
import {
  approveStoreOrderController,
  getStorefrontConfigController,
  listStoreOrdersController,
  rejectStoreOrderController,
  storeMetricsController,
  updateStorefrontConfigController,
} from "./storefront.controller";

const router = Router();

router.use(requireAuth);
router.get("/config", asyncHandler(getStorefrontConfigController));
router.put("/config", validate({ body: updateStorefrontConfigSchema }), asyncHandler(updateStorefrontConfigController));
router.get("/metrics", validate({ query: storeMetricsQuerySchema }), asyncHandler(storeMetricsController));
router.get("/orders", validate({ query: storeOrdersQuerySchema }), asyncHandler(listStoreOrdersController));
// Pedidos Yape/Plin: aprobar (crea el comprobante y entrega) o rechazar.
router.post("/orders/:id/approve", validate({ params: storeOrderParamsSchema, body: approveStoreOrderSchema }), asyncHandler(approveStoreOrderController));
router.post("/orders/:id/reject", validate({ params: storeOrderParamsSchema, body: rejectStoreOrderSchema }), asyncHandler(rejectStoreOrderController));

export default router;
