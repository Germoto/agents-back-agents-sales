import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import {
  getOrderDetailController,
  listOrdersController,
  registerOrderPaymentController,
  updateOrderShippingController,
  updateOrderStatusController,
} from "./orders.controller";
import {
  orderIdParamsSchema,
  registerOrderPaymentSchema,
  updateOrderShippingSchema,
  updateOrderStatusSchema,
} from "./orders.schemas";

const router = Router();

router.use(requireAuth);
router.get("/", asyncHandler(listOrdersController));
router.get("/:id", validate({ params: orderIdParamsSchema }), asyncHandler(getOrderDetailController));
router.put(
  "/:id/status",
  validate({ params: orderIdParamsSchema, body: updateOrderStatusSchema }),
  asyncHandler(updateOrderStatusController),
);
router.post(
  "/:id/payments",
  validate({ params: orderIdParamsSchema, body: registerOrderPaymentSchema }),
  asyncHandler(registerOrderPaymentController),
);
router.patch(
  "/:id/shipping",
  validate({ params: orderIdParamsSchema, body: updateOrderShippingSchema }),
  asyncHandler(updateOrderShippingController),
);

export default router;
