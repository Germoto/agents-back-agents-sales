import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { listDigitalSalesController } from "./digital-sales.controller";

const router = Router();

router.use(requireAuth);
router.get("/", asyncHandler(listDigitalSalesController));

export default router;
