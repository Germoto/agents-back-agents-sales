import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import { getOrderDetailController, listOrdersController, updateOrderStatusController } from "./orders.controller";
import { orderIdParamsSchema, updateOrderStatusSchema } from "./orders.schemas";

const router = Router();

router.use(requireAuth);
router.get("/", asyncHandler(listOrdersController));
router.get("/:id", validate({ params: orderIdParamsSchema }), asyncHandler(getOrderDetailController));
router.put(
  "/:id/status",
  validate({ params: orderIdParamsSchema, body: updateOrderStatusSchema }),
  asyncHandler(updateOrderStatusController),
);

export default router;
