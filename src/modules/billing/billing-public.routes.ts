import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { publicPlansController } from "./billing.controller";

// Planes públicos para la sección Precios del landing (sin auth).
const router = Router();

router.get("/", asyncHandler(publicPlansController));

export default router;
