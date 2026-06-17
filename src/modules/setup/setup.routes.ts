import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { getSetupStatusController } from "./setup.controller";

const router = Router();

router.use(requireAuth);
router.get("/status", asyncHandler(getSetupStatusController));

export default router;
