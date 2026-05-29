import { Router, Request, Response } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { hmacVerify } from "../../middlewares/hmac-verify.middleware";
import { processWebhook } from "./webhooks.service";

const router = Router();

/**
 * POST /api/webhooks/payments/:companyId
 *
 * Endpoint público (sin requireAuth) — autenticado via HMAC.
 * El middleware hmacVerify valida la firma y adjunta req.webhookEndpoint.
 */
router.post(
  "/payments/:companyId",
  hmacVerify,
  asyncHandler(async (req: Request, res: Response) => {
    const companyId = String(req.params.companyId);
    const endpoint = (req as any).webhookEndpoint;

    const result = await processWebhook(
      companyId,
      endpoint.id,
      endpoint.source,
      req.body,
    );

    res.json({ success: true, data: result });
  }),
);

export default router;
