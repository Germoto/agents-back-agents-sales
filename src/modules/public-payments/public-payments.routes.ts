import { Request, Response, Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import {
  listPendingPayments,
  getPaymentById,
  updatePaymentStatus,
  resolveCompanyIdByPhone,
} from "./public-payments.service";
import {
  listPendingQuerySchema,
  getOneQuerySchema,
  updateStatusBodySchema,
  updateStatusParamsSchema,
  updateStatusQuerySchema,
} from "./public-payments.schemas";

const router = Router();

/**
 * GET /api/public/payments/pending?phone=+51...&limit=50&since=ISO&source=validpay
 *
 * Lista comprobantes PENDIENTES de la company asociada al teléfono admin.
 * Misma estrategia que /api/bot/config (sin token).
 */
router.get(
  "/pending",
  asyncHandler(async (req: Request, res: Response) => {
    const query = listPendingQuerySchema.parse(req.query);
    const companyId = await resolveCompanyIdByPhone(query.phone);
    const data = await listPendingPayments(companyId, {
      limit: query.limit,
      since: query.since,
      source: query.source,
    });
    res.json({ success: true, data });
  }),
);

/**
 * GET /api/public/payments/:id?phone=+51...
 * Detalle de un comprobante (valida pertenencia a la company).
 */
router.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const query = getOneQuerySchema.parse(req.query);
    const { id } = updateStatusParamsSchema.parse(req.params);
    const companyId = await resolveCompanyIdByPhone(query.phone);
    const data = await getPaymentById(companyId, id);
    res.json({ success: true, data });
  }),
);

/**
 * PATCH /api/public/payments/:id/status?phone=+51...
 * Body: { status: APROBADO|RECHAZADO, reason?, customerPhone?, customerName?, productId?, note? }
 */
router.patch(
  "/:id/status",
  asyncHandler(async (req: Request, res: Response) => {
    const query = updateStatusQuerySchema.parse(req.query);
    const { id } = updateStatusParamsSchema.parse(req.params);
    const body = updateStatusBodySchema.parse(req.body);
    const companyId = await resolveCompanyIdByPhone(query.phone);
    const data = await updatePaymentStatus(companyId, id, body);
    res.json({ success: true, data });
  }),
);

export default router;
