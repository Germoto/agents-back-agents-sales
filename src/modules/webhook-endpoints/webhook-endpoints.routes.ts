import { Router, Request, Response } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { validate } from "../../middlewares/validate";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";
import {
  createWebhookEndpointSchema,
  updateWebhookEndpointSchema,
  idParamsSchema,
  regenerateSecretSchema,
} from "./webhook-endpoints.schema";
import {
  listWebhookEndpoints,
  createWebhookEndpoint,
  updateWebhookEndpoint,
  regenerateSecret,
  deleteWebhookEndpoint,
  listEndpointEvents,
} from "./webhook-endpoints.service";

const router = Router();

// Todos los endpoints requieren estar autenticado como ADMIN o SUPERADMIN
router.use(requireAuth, requireRole("ADMIN", "SUPERADMIN"));

// GET /api/webhook-endpoints
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const companyId = req.user!.companyId;
    const data = await listWebhookEndpoints(companyId);
    res.json({ success: true, data });
  }),
);

// POST /api/webhook-endpoints
router.post(
  "/",
  validate({ body: createWebhookEndpointSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const companyId = req.user!.companyId;
    const data = await createWebhookEndpoint(companyId, req.body);
    const base = process.env.PUBLIC_BASE_URL ?? "";
    const webhookUrl = `${base}/api/webhooks/payments/${companyId}`;
    res.status(201).json({ success: true, data: { ...data, webhookUrl } });
  }),
);

// PATCH /api/webhook-endpoints/:id
router.patch(
  "/:id",
  validate({ params: idParamsSchema, body: updateWebhookEndpointSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const companyId = req.user!.companyId;
    const data = await updateWebhookEndpoint(companyId, String(req.params.id), req.body);
    res.json({ success: true, data });
  }),
);

// POST /api/webhook-endpoints/:id/regenerate
router.post(
  "/:id/regenerate",
  validate({ params: idParamsSchema, body: regenerateSecretSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const companyId = req.user!.companyId;
    const data = await regenerateSecret(companyId, String(req.params.id), req.body.secret);
    res.json({ success: true, data });
  }),
);

// DELETE /api/webhook-endpoints/:id
router.delete(
  "/:id",
  validate({ params: idParamsSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const companyId = req.user!.companyId;
    const data = await deleteWebhookEndpoint(companyId, String(req.params.id));
    res.json({ success: true, data });
  }),
);

// GET /api/webhook-endpoints/:id/events
router.get(
  "/:id/events",
  validate({ params: idParamsSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const companyId = req.user!.companyId;
    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const { items, hasMore } = await listEndpointEvents(companyId, String(req.params.id), page, limit);
    res.json({ success: true, data: items, hasMore });
  }),
);

export default router;
