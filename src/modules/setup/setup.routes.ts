import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import { getSetupStatusController } from "./setup.controller";
import { getOnboardingController, updateOnboardingController } from "../onboarding/onboarding.controller";
import { updateOnboardingSchema } from "../onboarding/onboarding.schemas";

const router = Router();

router.use(requireAuth);
router.get("/status", asyncHandler(getSetupStatusController));
// Asistente de arranque: paso, borrador, saltos, menú simple/completo.
router.get("/onboarding", asyncHandler(getOnboardingController));
router.put("/onboarding", validate({ body: updateOnboardingSchema }), asyncHandler(updateOnboardingController));

export default router;
