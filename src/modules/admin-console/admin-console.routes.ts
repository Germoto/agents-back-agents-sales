import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate";
import {
  createClientController,
  deleteClientController,
  getVerticalsController,
  impersonateClientController,
  listClientsController,
  superadminLoginController,
  superadminMeController,
  updateClientStatusController,
  updateVerticalsController,
} from "./admin-console.controller";
import {
  clientIdParamsSchema,
  createClientSchema,
  superadminLoginSchema,
  updateClientStatusSchema,
  updateVerticalsSchema,
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
router.delete(
  "/clients/:id",
  requireAuth,
  requireRole("SUPERADMIN"),
  validate({ params: clientIdParamsSchema }),
  asyncHandler(deleteClientController),
);
router.post(
  "/clients/:id/impersonate",
  requireAuth,
  requireRole("SUPERADMIN"),
  validate({ params: clientIdParamsSchema }),
  asyncHandler(impersonateClientController),
);

// Config global de plataforma: rubros habilitados para todos los clientes.
router.get("/config/verticals", requireAuth, requireRole("SUPERADMIN"), asyncHandler(getVerticalsController));
router.put(
  "/config/verticals",
  requireAuth,
  requireRole("SUPERADMIN"),
  validate({ body: updateVerticalsSchema }),
  asyncHandler(updateVerticalsController),
);

export default router;
