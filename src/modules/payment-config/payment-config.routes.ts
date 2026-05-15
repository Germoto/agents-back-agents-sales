import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import { getPaymentConfigController, upsertPaymentConfigController } from "./payment-config.controller";
import { upsertPaymentConfigSchema } from "./payment-config.schemas";

const router = Router();

router.use(requireAuth);
router.get("/", asyncHandler(getPaymentConfigController));
router.put("/", validate({ body: upsertPaymentConfigSchema }), asyncHandler(upsertPaymentConfigController));

export default router;
