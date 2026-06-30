import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import {
  cancelCampaignController,
  createCampaignController,
  deleteCampaignController,
  getCampaignController,
  importContactsController,
  listCampaignsController,
  listContactsController,
  listRecipientsController,
  pauseCampaignController,
  resumeCampaignController,
  startCampaignController,
  testCampaignController,
  updateCampaignController,
} from "./campaigns.controller";
import {
  campaignIdParamsSchema,
  createCampaignSchema,
  testCampaignSchema,
  updateCampaignSchema,
} from "./campaigns.schemas";
import { importUploadMiddleware } from "./campaign-import";
import { uploadErrorTrap } from "../product-files/product-files.service";

const router = Router();

router.use(requireAuth);

// Rutas estáticas ANTES de las dinámicas (/:id) — requisito de Express 5.
router.get("/", asyncHandler(listCampaignsController));
router.post("/", validate({ body: createCampaignSchema }), asyncHandler(createCampaignController));
router.get("/contacts", asyncHandler(listContactsController));
router.post("/import", importUploadMiddleware, uploadErrorTrap, asyncHandler(importContactsController));

router.get("/:id", validate({ params: campaignIdParamsSchema }), asyncHandler(getCampaignController));
router.put(
  "/:id",
  validate({ params: campaignIdParamsSchema, body: updateCampaignSchema }),
  asyncHandler(updateCampaignController),
);
router.delete("/:id", validate({ params: campaignIdParamsSchema }), asyncHandler(deleteCampaignController));

router.get("/:id/recipients", validate({ params: campaignIdParamsSchema }), asyncHandler(listRecipientsController));
router.post("/:id/start", validate({ params: campaignIdParamsSchema }), asyncHandler(startCampaignController));
router.post("/:id/pause", validate({ params: campaignIdParamsSchema }), asyncHandler(pauseCampaignController));
router.post("/:id/resume", validate({ params: campaignIdParamsSchema }), asyncHandler(resumeCampaignController));
router.post("/:id/cancel", validate({ params: campaignIdParamsSchema }), asyncHandler(cancelCampaignController));
router.post(
  "/:id/test",
  validate({ params: campaignIdParamsSchema, body: testCampaignSchema }),
  asyncHandler(testCampaignController),
);

export default router;
