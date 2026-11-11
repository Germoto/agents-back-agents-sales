import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import { agencyCatalogStatusController, searchAgenciesController } from "./shipping.controller";
import { searchAgenciesQuerySchema } from "./shipping.schemas";

const router = Router();

router.use(requireAuth);
// Catálogo de agencias de courier (común a toda la plataforma, solo lectura).
router.get("/agencies/status", asyncHandler(agencyCatalogStatusController));
router.get("/agencies", validate({ query: searchAgenciesQuerySchema }), asyncHandler(searchAgenciesController));

export default router;
