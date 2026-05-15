import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import { listOrdersController, updateOrderStatusController } from "./orders.controller";
import { updateOrderStatusParamsSchema, updateOrderStatusSchema } from "./orders.schemas";

const router = Router();

router.use(requireAuth);
router.get("/", asyncHandler(listOrdersController));
router.put("/:id/status", validate({ params: updateOrderStatusParamsSchema, body: updateOrderStatusSchema }), asyncHandler(updateOrderStatusController));

export default router;
