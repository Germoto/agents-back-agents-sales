import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { validate } from "../../middlewares/validate";
import { makeRateLimiter } from "../../middlewares/rate-limit.middleware";
import {
  createPreRegistrationController,
  resendPreRegistrationCodeController,
  verifyPreRegistrationController,
} from "./registration.controller";
import { createPreRegistrationSchema, preRegIdParamsSchema, verifyCodeSchema } from "./registration.schemas";

// Pre-registro PÚBLICO del landing (sin auth). Protegido por rate limiting.
const router = Router();

const createLimiter = makeRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 8,
  message: "Demasiados intentos de registro. Inténtalo de nuevo en unos minutos.",
});
const verifyLimiter = makeRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: "Demasiados intentos. Espera unos minutos.",
});

router.post("/", createLimiter, validate({ body: createPreRegistrationSchema }), asyncHandler(createPreRegistrationController));
router.post(
  "/:id/verify",
  verifyLimiter,
  validate({ params: preRegIdParamsSchema, body: verifyCodeSchema }),
  asyncHandler(verifyPreRegistrationController),
);
router.post(
  "/:id/resend",
  createLimiter,
  validate({ params: preRegIdParamsSchema }),
  asyncHandler(resendPreRegistrationCodeController),
);

export default router;
