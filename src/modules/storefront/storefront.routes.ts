/** Rutas del PANEL para configurar la tienda web (/api/storefront). */

import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import { storeOrdersQuerySchema, updateStorefrontConfigSchema } from "./storefront.schemas";
import { getStorefrontConfigController, listStoreOrdersController, updateStorefrontConfigController } from "./storefront.controller";

const router = Router();

router.use(requireAuth);
router.get("/config", asyncHandler(getStorefrontConfigController));
router.put("/config", validate({ body: updateStorefrontConfigSchema }), asyncHandler(updateStorefrontConfigController));
router.get("/orders", validate({ query: storeOrdersQuerySchema }), asyncHandler(listStoreOrdersController));

export default router;
