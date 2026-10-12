/** Rutas del PANEL para configurar la tienda web (/api/storefront). */

import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import { approveStoreOrderSchema, campaignAudiencePreviewSchema, campaignIdParamsSchema, campaignStartSchema, campaignTestSchema, couponIdParamsSchema, createCampaignSchema, createCouponSchema, emailContactsQuerySchema, rejectStoreOrderSchema, storeEmailTestSchema, storeEmailsQuerySchema, updateCampaignSchema, updateCouponSchema, storeMetricsQuerySchema, storeOrderParamsSchema, storeOrdersQuerySchema, updateStorefrontConfigSchema } from "./storefront.schemas";
import {
  approveStoreOrderController,
  cancelCampaignController,
  campaignTestController,
  createCampaignController,
  deleteCampaignController,
  duplicateCampaignController,
  emailContactsController,
  emailTagsController,
  getCampaignController,
  listCampaignsController,
  previewAudienceController,
  startCampaignController,
  updateCampaignController,
  createCouponController,
  deleteCouponController,
  listCouponsController,
  listStoreEmailsController,
  storeEmailTestController,
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
// Correos automáticos: historial y prueba
router.get("/emails", validate({ query: storeEmailsQuerySchema }), asyncHandler(listStoreEmailsController));
router.post("/emails/test", validate({ body: storeEmailTestSchema }), asyncHandler(storeEmailTestController));
// Campañas de correo (promociones)
router.get("/email-campaigns", asyncHandler(listCampaignsController));
router.post("/email-campaigns", validate({ body: createCampaignSchema }), asyncHandler(createCampaignController));
router.post("/email-campaigns/preview-audience", validate({ body: campaignAudiencePreviewSchema }), asyncHandler(previewAudienceController));
router.get("/email-campaigns/contacts", validate({ query: emailContactsQuerySchema }), asyncHandler(emailContactsController));
router.get("/email-campaigns/tags", asyncHandler(emailTagsController));
router.get("/email-campaigns/:id", validate({ params: campaignIdParamsSchema }), asyncHandler(getCampaignController));
router.put("/email-campaigns/:id", validate({ params: campaignIdParamsSchema, body: updateCampaignSchema }), asyncHandler(updateCampaignController));
router.delete("/email-campaigns/:id", validate({ params: campaignIdParamsSchema }), asyncHandler(deleteCampaignController));
router.post("/email-campaigns/:id/duplicate", validate({ params: campaignIdParamsSchema }), asyncHandler(duplicateCampaignController));
router.post("/email-campaigns/:id/test", validate({ params: campaignIdParamsSchema, body: campaignTestSchema }), asyncHandler(campaignTestController));
router.post("/email-campaigns/:id/start", validate({ params: campaignIdParamsSchema, body: campaignStartSchema }), asyncHandler(startCampaignController));
router.post("/email-campaigns/:id/cancel", validate({ params: campaignIdParamsSchema }), asyncHandler(cancelCampaignController));
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
