/** Rutas del PANEL para configurar la tienda web (/api/storefront). */

import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import { approveStoreOrderSchema, couponIdParamsSchema, createCouponSchema, rejectStoreOrderSchema, updateCouponSchema, storeMetricsQuerySchema, storeOrderParamsSchema, storeOrdersQuerySchema, updateStorefrontConfigSchema } from "./storefront.schemas";
import {
  approveStoreOrderController,
  createCouponController,
  deleteCouponController,
  listCouponsController,
  updateCouponController,
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

// Cupones de descuento
router.get("/coupons", asyncHandler(listCouponsController));
router.post("/coupons", validate({ body: createCouponSchema }), asyncHandler(createCouponController));
router.put("/coupons/:id", validate({ params: couponIdParamsSchema, body: updateCouponSchema }), asyncHandler(updateCouponController));
router.delete("/coupons/:id", validate({ params: couponIdParamsSchema }), asyncHandler(deleteCouponController));

export default router;
