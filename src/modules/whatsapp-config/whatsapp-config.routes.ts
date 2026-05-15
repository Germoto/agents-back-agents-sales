import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import {
  getWhatsappConfigController,
  testWhatsappConnectionController,
  upsertWhatsappConfigController,
} from "./whatsapp-config.controller";
import { testWhatsappConnectionSchema, upsertWhatsappConfigSchema } from "./whatsapp-config.schemas";

const router = Router();

router.use(requireAuth);
router.get("/", asyncHandler(getWhatsappConfigController));
router.put("/", validate({ body: upsertWhatsappConfigSchema }), asyncHandler(upsertWhatsappConfigController));
router.post("/test", validate({ body: testWhatsappConnectionSchema }), asyncHandler(testWhatsappConnectionController));

export default router;
