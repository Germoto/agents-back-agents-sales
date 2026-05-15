import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { optionalBotApiKey } from "../../middlewares/optional-api-key";
import { getBotConfigController } from "./bot.controller";

const router = Router();

router.get("/config", optionalBotApiKey, asyncHandler(getBotConfigController));

export default router;
