import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import {
  getAgentConfigController,
  upsertAgentConfigController,
  updateRemindersController,
  updateMutedNumbersController,
  updateReplyModeController,
} from "./agent-config.controller";
import {
  coreAgentConfigSchema,
  mutedNumbersConfigSchema,
  remindersConfigSchema,
  replyModeConfigSchema,
} from "./agent-config.schemas";

const router = Router();

router.use(requireAuth);
router.get("/", asyncHandler(getAgentConfigController));
router.put("/", validate({ body: coreAgentConfigSchema }), asyncHandler(upsertAgentConfigController));
router.put("/reminders", validate({ body: remindersConfigSchema }), asyncHandler(updateRemindersController));
router.put("/reply-mode", validate({ body: replyModeConfigSchema }), asyncHandler(updateReplyModeController));
router.put("/muted-numbers", validate({ body: mutedNumbersConfigSchema }), asyncHandler(updateMutedNumbersController));

export default router;
