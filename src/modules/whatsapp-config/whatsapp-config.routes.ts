import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import {
  createWhatsappLinkController,
  deleteWhatsappAccountController,
  deleteWhatsappReceivedController,
  deleteWhatsappSentController,
  getWhatsappConfigController,
  getWhatsappLinkInfoController,
  getWhatsappQrImageController,
  listWhatsappAccountsController,
  listWhatsappPendingController,
  listWhatsappReceivedController,
  listWhatsappSentController,
  listWhatsappServersController,
  relinkWhatsappAccountController,
  syncWhatsappAccountController,
  testWhatsappConnectionController,
  upsertWhatsappConfigController,
  updateMetaConfigController,
  getMetaStatusController,
  listMetaTemplatesController,
} from "./whatsapp-config.controller";
import {
  linkSchema,
  paginationSchema,
  relinkSchema,
  testWhatsappConnectionSchema,
  tokenQuerySchema,
  upsertWhatsappConfigSchema,
  updateMetaConfigSchema,
} from "./whatsapp-config.schemas";

const router = Router();

router.use(requireAuth);

router.get("/", asyncHandler(getWhatsappConfigController));
router.put("/", validate({ body: upsertWhatsappConfigSchema }), asyncHandler(upsertWhatsappConfigController));
router.post("/test", validate({ body: testWhatsappConnectionSchema }), asyncHandler(testWhatsappConnectionController));

// Proveedor API oficial de Meta (Cloud API): credenciales, semáforo y plantillas
router.put("/meta", validate({ body: updateMetaConfigSchema }), asyncHandler(updateMetaConfigController));
router.get("/meta/status", asyncHandler(getMetaStatusController));
router.get("/meta/templates", asyncHandler(listMetaTemplatesController));

router.get("/servers", asyncHandler(listWhatsappServersController));

router.get(
  "/accounts",
  validate({ query: paginationSchema }),
  asyncHandler(listWhatsappAccountsController),
);
router.delete("/accounts/:unique", asyncHandler(deleteWhatsappAccountController));
router.post("/sync", asyncHandler(syncWhatsappAccountController));

router.post("/link", validate({ body: linkSchema }), asyncHandler(createWhatsappLinkController));
router.post("/relink", validate({ body: relinkSchema }), asyncHandler(relinkWhatsappAccountController));

router.get("/qr-image", validate({ query: tokenQuerySchema }), asyncHandler(getWhatsappQrImageController));
router.get("/link-info", validate({ query: tokenQuerySchema }), asyncHandler(getWhatsappLinkInfoController));

router.get(
  "/messages/pending",
  validate({ query: paginationSchema }),
  asyncHandler(listWhatsappPendingController),
);
router.get(
  "/messages/sent",
  validate({ query: paginationSchema }),
  asyncHandler(listWhatsappSentController),
);
router.get(
  "/messages/received",
  validate({ query: paginationSchema }),
  asyncHandler(listWhatsappReceivedController),
);
router.delete("/messages/sent/:id", asyncHandler(deleteWhatsappSentController));
router.delete("/messages/received/:id", asyncHandler(deleteWhatsappReceivedController));

export default router;
