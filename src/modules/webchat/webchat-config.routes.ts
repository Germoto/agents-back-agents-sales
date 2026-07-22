/** Rutas del PANEL para configurar el Chat Web (/api/webchat-config). */

import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import { updateWebchatConfigSchema } from "./webchat.schemas";
import {
  getWebchatConfigController,
  updateWebchatConfigController,
  regenerateTokenController,
} from "./webchat.controller";

const router = Router();

router.use(requireAuth);

router.get("/", asyncHandler(getWebchatConfigController));
router.put("/", validate({ body: updateWebchatConfigSchema }), asyncHandler(updateWebchatConfigController));
router.post("/regenerate-token", asyncHandler(regenerateTokenController));

export default router;
