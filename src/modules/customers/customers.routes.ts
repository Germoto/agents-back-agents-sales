import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { listCustomersController } from "./customers.controller";

const router = Router();

router.use(requireAuth);
router.get("/", asyncHandler(listCustomersController));

export default router;
