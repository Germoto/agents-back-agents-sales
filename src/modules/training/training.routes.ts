import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { listActiveTrainingResourcesController } from "./training.controller";

// Recursos de capacitación vistos por el TENANT (Centro de ayuda / Activación).
// Solo requireAuth: cualquier rol autenticado los ve, incluso con la
// suscripción vencida — nunca montarles el billingGuard.
const router = Router();

router.get("/", requireAuth, asyncHandler(listActiveTrainingResourcesController));

export default router;
