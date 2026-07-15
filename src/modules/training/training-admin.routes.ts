import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate";
import { uploadTrainingFileMiddleware } from "../../middlewares/upload.middleware";
import {
  createTrainingResourceController,
  deleteTrainingResourceController,
  listTrainingResourcesController,
  updateTrainingResourceController,
} from "./training-admin.controller";
import {
  deleteOrphanTrainingHandler,
  trainingUploadErrorTrap,
  uploadTrainingHandler,
} from "./training-admin.service";
import { trainingIdParamsSchema, trainingResourceInputSchema } from "./training.schemas";

const router = Router();

// Acotado por prefijo: este router se monta sin path dentro de admin-console,
// y un use() global le colgaría requireAuth al login del superadmin.
router.use(["/training-resources"], requireAuth, requireRole("SUPERADMIN"));

// Recursos de capacitación globales (Centro de ayuda de los tenants)
router.get("/training-resources", asyncHandler(listTrainingResourcesController));
router.post(
  "/training-resources",
  validate({ body: trainingResourceInputSchema }),
  asyncHandler(createTrainingResourceController),
);
router.put(
  "/training-resources/:id",
  validate({ params: trainingIdParamsSchema, body: trainingResourceInputSchema }),
  asyncHandler(updateTrainingResourceController),
);
router.delete(
  "/training-resources/:id",
  validate({ params: trainingIdParamsSchema }),
  asyncHandler(deleteTrainingResourceController),
);

// Subida de archivo (PDF/video) a la carpeta global training/
router.post(
  "/training-resources/upload",
  (req, res, next) => uploadTrainingFileMiddleware(req, res, (err) => trainingUploadErrorTrap(err, req, res, next)),
  asyncHandler(uploadTrainingHandler),
);
// Limpieza de un archivo subido que no llegó a guardarse como recurso
router.post("/training-resources/orphan-delete", asyncHandler(deleteOrphanTrainingHandler));

export default router;
