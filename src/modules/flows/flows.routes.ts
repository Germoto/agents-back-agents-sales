import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import {
  listFlowsController,
  getFlowController,
  createFlowController,
  updateFlowController,
  duplicateFlowController,
  toggleFlowController,
  validateFlowController,
  deleteFlowController,
} from "./flows.controller";
import {
  createFlowSchema,
  updateFlowSchema,
  toggleFlowSchema,
  validateFlowSchema,
  copilotSchema,
} from "./flows.schemas";
import { copilotFlowController } from "./flows.copilot";
import { flowAiSuggestController, flowAiSuggestSchema } from "./flows.ai";

const router = Router();

router.use(requireAuth);

// Estáticas antes de /:id (Express 5)
router.post("/validate", validate({ body: validateFlowSchema }), asyncHandler(validateFlowController));
router.post("/ai-suggest-text", validate({ body: flowAiSuggestSchema }), asyncHandler(flowAiSuggestController));

router.get("/", asyncHandler(listFlowsController));
router.post("/", validate({ body: createFlowSchema }), asyncHandler(createFlowController));
router.get("/:id", asyncHandler(getFlowController));
router.put("/:id", validate({ body: updateFlowSchema }), asyncHandler(updateFlowController));
router.post("/:id/duplicate", asyncHandler(duplicateFlowController));
router.post("/:id/copilot", validate({ body: copilotSchema }), asyncHandler(copilotFlowController));
router.post("/:id/toggle", validate({ body: toggleFlowSchema }), asyncHandler(toggleFlowController));
router.delete("/:id", asyncHandler(deleteFlowController));

export default router;
