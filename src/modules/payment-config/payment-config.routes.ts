import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import { getPaymentConfigController, upsertPaymentConfigController, updateMercadoPagoController, testMercadoPagoController } from "./payment-config.controller";
import { upsertPaymentConfigSchema, updateMercadoPagoSchema } from "./payment-config.schemas";

const router = Router();

router.use(requireAuth);
router.get("/", asyncHandler(getPaymentConfigController));
router.put("/", validate({ body: upsertPaymentConfigSchema }), asyncHandler(upsertPaymentConfigController));
router.put("/mercadopago", validate({ body: updateMercadoPagoSchema }), asyncHandler(updateMercadoPagoController));
router.post("/mercadopago/test", asyncHandler(testMercadoPagoController));

export default router;
