import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate";
import {
  createClientController,
  listClientsController,
  superadminLoginController,
  superadminMeController,
  updateClientStatusController,
} from "./admin-console.controller";
import {
  clientIdParamsSchema,
  createClientSchema,
  superadminLoginSchema,
  updateClientStatusSchema,
} from "./admin-console.schemas";

const router = Router();

router.post("/auth/login", validate({ body: superadminLoginSchema }), asyncHandler(superadminLoginController));
router.get("/auth/me", requireAuth, requireRole("SUPERADMIN"), asyncHandler(superadminMeController));
router.get("/clients", requireAuth, requireRole("SUPERADMIN"), asyncHandler(listClientsController));
router.post("/clients", requireAuth, requireRole("SUPERADMIN"), validate({ body: createClientSchema }), asyncHandler(createClientController));
router.put(
  "/clients/:id/status",
  requireAuth,
  requireRole("SUPERADMIN"),
  validate({ params: clientIdParamsSchema, body: updateClientStatusSchema }),
  asyncHandler(updateClientStatusController),
);

export default router;
