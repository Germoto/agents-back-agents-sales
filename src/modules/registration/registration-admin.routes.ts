import { Router } from "express";
import type { Request, Response } from "express";
import type { PreRegistrationStatus } from "@prisma/client";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate";
import {
  convertPreRegistration,
  countPendingPreRegistrations,
  deletePreRegistration,
  listPreRegistrations,
  rejectPreRegistration,
  updatePreRegistration,
} from "./registration-admin.service";
import {
  convertPreRegistrationSchema,
  preRegIdParamsSchema,
  rejectPreRegistrationSchema,
  updatePreRegistrationAdminSchema,
} from "./registration.schemas";

// Gestión de pre-registros — se monta sin path dentro de admin-console
// (hereda /api/control-room-7m4x). Acotado por prefijo para no colgarle
// requireAuth al login del superadmin.
const router = Router();

router.use(["/pre-registrations"], requireAuth, requireRole("SUPERADMIN"));

const paramId = (req: Request) => {
  const value = req.params.id;
  return Array.isArray(value) ? value[0] : value;
};

router.get(
  "/pre-registrations",
  asyncHandler(async (req: Request, res: Response) => {
    const status = req.query.status as PreRegistrationStatus | undefined;
    return res.json(await listPreRegistrations(status));
  }),
);
router.get(
  "/pre-registrations/pending-count",
  asyncHandler(async (_req: Request, res: Response) => res.json(await countPendingPreRegistrations())),
);
router.put(
  "/pre-registrations/:id",
  validate({ params: preRegIdParamsSchema, body: updatePreRegistrationAdminSchema }),
  asyncHandler(async (req: Request, res: Response) => res.json(await updatePreRegistration(paramId(req), req.body))),
);
router.post(
  "/pre-registrations/:id/convert",
  validate({ params: preRegIdParamsSchema, body: convertPreRegistrationSchema }),
  asyncHandler(async (req: Request, res: Response) =>
    res.status(201).json(await convertPreRegistration(paramId(req), req.body)),
  ),
);
router.post(
  "/pre-registrations/:id/reject",
  validate({ params: preRegIdParamsSchema, body: rejectPreRegistrationSchema }),
  asyncHandler(async (req: Request, res: Response) =>
    res.json(await rejectPreRegistration(paramId(req), req.body?.reason)),
  ),
);
router.delete(
  "/pre-registrations/:id",
  validate({ params: preRegIdParamsSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    await deletePreRegistration(paramId(req));
    return res.status(204).send();
  }),
);

export default router;
