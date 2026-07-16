import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import { makeRateLimiter } from "../../middlewares/rate-limit.middleware";
import {
  changePasswordController,
  confirmPasswordResetController,
  loginController,
  meController,
  requestPasswordResetController,
  updateUiThemeController,
} from "./auth.controller";
import {
  changePasswordSchema,
  confirmResetSchema,
  loginSchema,
  requestResetSchema,
  updateUiThemeSchema,
} from "./auth.schemas";

const router = Router();

// Recuperación de contraseña (pública, con rate limiting propio).
const resetRequestLimiter = makeRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 8,
  message: "Demasiadas solicitudes. Inténtalo de nuevo en unos minutos.",
});
const resetConfirmLimiter = makeRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: "Demasiados intentos. Espera unos minutos.",
});

router.post("/login", validate({ body: loginSchema }), asyncHandler(loginController));
router.get("/me", requireAuth, asyncHandler(meController));
router.patch("/me/ui-theme", requireAuth, validate({ body: updateUiThemeSchema }), asyncHandler(updateUiThemeController));

router.post(
  "/password-reset/request",
  resetRequestLimiter,
  validate({ body: requestResetSchema }),
  asyncHandler(requestPasswordResetController),
);
router.post(
  "/password-reset/confirm",
  resetConfirmLimiter,
  validate({ body: confirmResetSchema }),
  asyncHandler(confirmPasswordResetController),
);
router.post(
  "/change-password",
  requireAuth,
  validate({ body: changePasswordSchema }),
  asyncHandler(changePasswordController),
);

export default router;
