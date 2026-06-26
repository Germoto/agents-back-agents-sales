import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import {
  listSubscriptionsController,
  createSubscriptionController,
  renewSubscriptionController,
  cancelSubscriptionController,
  deleteSubscriptionController,
} from "./subscriptions.controller";

const router = Router();

router.use(requireAuth);
router.get("/", asyncHandler(listSubscriptionsController));
router.post("/", asyncHandler(createSubscriptionController));
router.post("/:id/renew", asyncHandler(renewSubscriptionController));
router.post("/:id/cancel", asyncHandler(cancelSubscriptionController));
router.delete("/:id", asyncHandler(deleteSubscriptionController));

export default router;
