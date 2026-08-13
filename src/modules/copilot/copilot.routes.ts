import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import { copilotChatController } from "./copilot.controller";
import { copilotChatSchema } from "./copilot.schemas";

const router = Router();

router.use(requireAuth);

router.post("/chat", validate({ body: copilotChatSchema }), asyncHandler(copilotChatController));

export default router;
