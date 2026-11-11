import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import { getBusinessProfileController, updateBusinessProfileController } from "./business.controller";
import { updateBusinessSchema } from "./business.schemas";
import {
  getShippingConfigController,
  patchShippingConfigController,
  saveShippingConfigController,
} from "../shipping/shipping.controller";

const router = Router();

router.use(requireAuth);
router.get("/profile", asyncHandler(getBusinessProfileController));
router.put("/profile", validate({ body: updateBusinessSchema }), asyncHandler(updateBusinessProfileController));
// «Envíos» (rubro comercial): aparte del perfil para que guardar Empresa no lo pise.
// PUT reemplaza todo (panel); PATCH cambia solo lo indicado (asistente de arranque).
// El cuerpo lo valida el servicio con shippingConfigSchema.
router.get("/shipping-config", asyncHandler(getShippingConfigController));
router.put("/shipping-config", asyncHandler(saveShippingConfigController));
router.patch("/shipping-config", asyncHandler(patchShippingConfigController));

export default router;
