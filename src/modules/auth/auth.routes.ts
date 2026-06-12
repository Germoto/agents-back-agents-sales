import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import { loginController, meController, updateUiThemeController } from "./auth.controller";
import { loginSchema, updateUiThemeSchema } from "./auth.schemas";

const router = Router();

router.post("/login", validate({ body: loginSchema }), asyncHandler(loginController));
router.get("/me", requireAuth, asyncHandler(meController));
router.patch("/me/ui-theme", requireAuth, validate({ body: updateUiThemeSchema }), asyncHandler(updateUiThemeController));

export default router;
