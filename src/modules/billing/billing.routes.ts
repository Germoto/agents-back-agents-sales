import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate";
import {
  billingMeController,
  myCreditTransactionsController,
  redeemVoucherController,
  mpCheckoutController,
  myPurchasesController,
} from "./billing.controller";
import { redeemVoucherSchema, mpCheckoutSchema } from "./billing.schemas";

// Billing visto por el TENANT. IMPORTANTE: estas rutas deben funcionar
// incluso con la suscripción vencida (aquí se renueva) — nunca montarles
// el billingGuard.
const router = Router();

router.get("/me", requireAuth, asyncHandler(billingMeController));
router.get("/credits/transactions", requireAuth, asyncHandler(myCreditTransactionsController));
router.post(
  "/redeem",
  requireAuth,
  requireRole("ADMIN", "SUPERADMIN"),
  validate({ body: redeemVoucherSchema }),
  asyncHandler(redeemVoucherController),
);
// Checkout Mercado Pago de plataforma: pagar plan (1 o 12 meses) o recargar créditos
router.post(
  "/mp/checkout",
  requireAuth,
  requireRole("ADMIN", "SUPERADMIN"),
  validate({ body: mpCheckoutSchema }),
  asyncHandler(mpCheckoutController),
);
router.get("/purchases", requireAuth, asyncHandler(myPurchasesController));

export default router;
