import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate";
import {
  adjustCreditsController,
  assignSubscriptionController,
  cancelSubscriptionController,
  companyCreditTransactionsController,
  createPlanController,
  createVoucherBatchController,
  deletePlanController,
  deleteSubscriptionController,
  deleteVoucherController,
  extendSubscriptionController,
  listPlansController,
  listSubscriptionsController,
  listVouchersController,
  updatePlanController,
} from "./billing-admin.controller";
import {
  adjustCreditsSchema,
  assignSubscriptionSchema,
  billingCompanyIdParamsSchema,
  billingIdParamsSchema,
  extendSubscriptionSchema,
  planInputSchema,
  voucherBatchSchema,
  vouchersQuerySchema,
} from "./billing.schemas";

// Administración de la monetización. Se monta DENTRO de admin-console.routes
// para heredar el prefijo /api/control-room-7m4x.
const router = Router();

// Acotado por prefijo: este router se monta sin path dentro de admin-console,
// y un use() global le colgaría requireAuth al login del superadmin.
router.use(["/plans", "/subscriptions", "/vouchers", "/credits"], requireAuth, requireRole("SUPERADMIN"));

// Paquetes
router.get("/plans", asyncHandler(listPlansController));
router.post("/plans", validate({ body: planInputSchema }), asyncHandler(createPlanController));
router.put(
  "/plans/:id",
  validate({ params: billingIdParamsSchema, body: planInputSchema }),
  asyncHandler(updatePlanController),
);
router.delete("/plans/:id", validate({ params: billingIdParamsSchema }), asyncHandler(deletePlanController));

// Suscripciones de tenants
router.get("/subscriptions", asyncHandler(listSubscriptionsController));
router.post("/subscriptions", validate({ body: assignSubscriptionSchema }), asyncHandler(assignSubscriptionController));
router.put(
  "/subscriptions/:id/extend",
  validate({ params: billingIdParamsSchema, body: extendSubscriptionSchema }),
  asyncHandler(extendSubscriptionController),
);
router.put(
  "/subscriptions/:id/cancel",
  validate({ params: billingIdParamsSchema }),
  asyncHandler(cancelSubscriptionController),
);
router.delete(
  "/subscriptions/:id",
  validate({ params: billingIdParamsSchema }),
  asyncHandler(deleteSubscriptionController),
);

// Vales
router.get("/vouchers", validate({ query: vouchersQuerySchema }), asyncHandler(listVouchersController));
router.post("/vouchers", validate({ body: voucherBatchSchema }), asyncHandler(createVoucherBatchController));
router.delete("/vouchers/:id", validate({ params: billingIdParamsSchema }), asyncHandler(deleteVoucherController));

// Créditos
router.post("/credits", validate({ body: adjustCreditsSchema }), asyncHandler(adjustCreditsController));
router.get(
  "/credits/:companyId/transactions",
  validate({ params: billingCompanyIdParamsSchema }),
  asyncHandler(companyCreditTransactionsController),
);

export default router;
