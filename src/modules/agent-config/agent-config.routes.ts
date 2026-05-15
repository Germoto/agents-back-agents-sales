import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import { getAgentConfigController, upsertAgentConfigController } from "./agent-config.controller";
import { upsertAgentConfigSchema } from "./agent-config.schemas";

const router = Router();

router.use(requireAuth);
router.get("/", asyncHandler(getAgentConfigController));
router.put("/", validate({ body: upsertAgentConfigSchema }), asyncHandler(upsertAgentConfigController));

export default router;
