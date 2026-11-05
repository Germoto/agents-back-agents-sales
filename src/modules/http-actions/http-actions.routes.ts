import { Router, Request, Response } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { validate } from "../../middlewares/validate";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";
import {
  createActionSchema,
  createConnectionSchema,
  idParamsSchema,
  listRunsQuerySchema,
  testInlineSchema,
  testVarsSchema,
  updateActionSchema,
  updateConnectionSchema,
} from "./http-actions.schemas";
import {
  createAction,
  createConnection,
  deleteAction,
  deleteConnection,
  getAction,
  listActions,
  listConnections,
  listRuns,
  releaseRun,
  testAction,
  testInline,
  updateAction,
  updateConnection,
} from "./http-actions.service";

const router = Router();

router.use(requireAuth, requireRole("ADMIN", "SUPERADMIN"));

// --- Conexiones ---
router.get(
  "/connections",
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await listConnections(req.user!.companyId) });
  }),
);
router.post(
  "/connections",
  validate({ body: createConnectionSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json({ success: true, data: await createConnection(req.user!.companyId, req.body) });
  }),
);
router.patch(
  "/connections/:id",
  validate({ params: idParamsSchema, body: updateConnectionSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await updateConnection(req.user!.companyId, String(req.params.id), req.body) });
  }),
);
router.delete(
  "/connections/:id",
  validate({ params: idParamsSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await deleteConnection(req.user!.companyId, String(req.params.id)) });
  }),
);

// --- Acciones ---
router.get(
  "/actions",
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await listActions(req.user!.companyId) });
  }),
);
router.post(
  "/actions",
  validate({ body: createActionSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json({ success: true, data: await createAction(req.user!.companyId, req.body) });
  }),
);
// Probar una petición sin guardarla (editor de flujos / editor de acciones).
router.post(
  "/actions/test-inline",
  validate({ body: testInlineSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await testInline(req.user!.companyId, req.body.request, req.body.vars ?? {}) });
  }),
);
router.get(
  "/actions/:id",
  validate({ params: idParamsSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await getAction(req.user!.companyId, String(req.params.id)) });
  }),
);
router.patch(
  "/actions/:id",
  validate({ params: idParamsSchema, body: updateActionSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await updateAction(req.user!.companyId, String(req.params.id), req.body) });
  }),
);
router.delete(
  "/actions/:id",
  validate({ params: idParamsSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await deleteAction(req.user!.companyId, String(req.params.id)) });
  }),
);
router.post(
  "/actions/:id/test",
  validate({ params: idParamsSchema, body: testVarsSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await testAction(req.user!.companyId, String(req.params.id), req.body.vars ?? {}) });
  }),
);

// --- Historial ---
router.get(
  "/runs",
  validate({ query: listRunsQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as { actionId?: string; page: number; limit: number };
    const { items, hasMore } = await listRuns(req.user!.companyId, { actionId: q.actionId, page: q.page, limit: q.limit });
    res.json({ success: true, data: items, hasMore });
  }),
);

// Permitir de nuevo una acción "una vez por cliente" (quita la llave de idempotencia de esa ejecución).
router.post(
  "/runs/:id/release",
  validate({ params: idParamsSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await releaseRun(req.user!.companyId, String(req.params.id)) });
  }),
);

export default router;
