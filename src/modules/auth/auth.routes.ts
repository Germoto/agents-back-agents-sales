import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import { loginController, meController } from "./auth.controller";
import { loginSchema } from "./auth.schemas";

const router = Router();

router.post("/login", validate({ body: loginSchema }), asyncHandler(loginController));
router.get("/me", requireAuth, asyncHandler(meController));

export default router;
