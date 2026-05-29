import { Request, Response, Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import {
  listPendingPayments,
  getPaymentById,
  updatePaymentStatus,
  resolveCompanyIdByPhone,
  matchPayments,
  claimPayment,
} from "./public-payments.service";
import {
  listPendingQuerySchema,
  getOneQuerySchema,
  updateStatusBodySchema,
  updateStatusParamsSchema,
  updateStatusQuerySchema,
  matchBodySchema,
  claimBodySchema,
  phoneQuerySchema,
} from "./public-payments.schemas";

const router = Router();

/**
 * GET /api/public/payments/pending
 *
 * Filtros opcionales (query):
 *   phone (req)  · limit · since · source · status
 *   amountPaid · payerName · occurredFrom · occurredTo · paymentSource
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
      amountPaid: query.amountPaid,
      payerName: query.payerName,
      occurredFrom: query.occurredFrom,
      occurredTo: query.occurredTo,
      paymentSource: query.paymentSource,
      status: query.status,
    });
    res.json({ success: true, data });
  }),
);

/**
 * POST /api/public/payments/match?phone=+51...
 * Body: { amountPaid?, payerName?, paymentSource?, occurredFrom?, occurredTo?, source?, limit? }
 *
 * Devuelve candidatos PENDIENTES con matchScore y matchReasons.
 * No aprueba nada — solo ranking.
 */
router.post(
  "/match",
  asyncHandler(async (req: Request, res: Response) => {
    const query = phoneQuerySchema.parse(req.query);
    const body = matchBodySchema.parse(req.body);
    const companyId = await resolveCompanyIdByPhone(query.phone);
    const data = await matchPayments(companyId, body);
    res.json({ success: true, data });
  }),
);

/**
 * GET /api/public/payments/:id?phone=+51...
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
 * POST /api/public/payments/:id/claim?phone=+51...
 * Body: { claimedBy: string, claimTtlSeconds?: number (5..600, default 120) }
 *
 * Reclama temporalmente el pago para evitar doble procesamiento.
 * Devuelve 409 si ya está reclamado y vigente, o si está APROBADO/RECHAZADO.
 */
router.post(
  "/:id/claim",
  asyncHandler(async (req: Request, res: Response) => {
    const query = phoneQuerySchema.parse(req.query);
    const { id } = updateStatusParamsSchema.parse(req.params);
    const body = claimBodySchema.parse(req.body);
    const companyId = await resolveCompanyIdByPhone(query.phone);
    const data = await claimPayment(companyId, id, body);
    res.json({ success: true, data });
  }),
);

/**
 * PATCH /api/public/payments/:id/status?phone=+51...
 * Body retrocompatible. Ver docs/public-payments-api.md
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
