import { Router, Request, Response } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { hmacVerify } from "../../middlewares/hmac-verify.middleware";
import { processWebhook } from "./webhooks.service";
import { processMercadoPagoWebhook } from "./mercadopago-webhook.service";

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

/**
 * POST /api/webhooks/mercadopago/:companyId
 *
 * Público, SIN HMAC: la notificación de MP solo trae el id del pago y el
 * backend lo verifica contra la API de MP con el token del tenant (fuente de
 * verdad). Siempre responde 200 rápido (MP reintenta ante errores).
 */
router.post(
  "/mercadopago/:companyId",
  asyncHandler(async (req: Request, res: Response) => {
    const companyId = String(req.params.companyId);
    try {
      const result = await processMercadoPagoWebhook(
        companyId,
        req.body,
        req.query as Record<string, unknown>,
      );
      res.json({ success: true, data: result });
    } catch (err) {
      console.error("[mp-webhook] error:", err instanceof Error ? err.message : err);
      res.json({ success: true, data: { ok: false } });
    }
  }),
);

export default router;
