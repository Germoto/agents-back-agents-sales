import crypto from "crypto";
import { Request, Response } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { env } from "../../config/env";
import { parseMetaWebhook } from "../../lib/meta-webhook-parser";
import { processMetaWebhook } from "./meta-webhook.service";

/**
 * GET /api/meta/webhook — verificación de suscripción del webhook en el
 * dashboard de Meta: hay que devolver hub.challenge en texto plano si el
 * verify_token coincide con META_WEBHOOK_VERIFY_TOKEN.
 */
export const verifyWebhookController = asyncHandler(async (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (
    mode === "subscribe" &&
    env.META_WEBHOOK_VERIFY_TOKEN &&
    token === env.META_WEBHOOK_VERIFY_TOKEN &&
    typeof challenge === "string"
  ) {
    res.status(200).send(challenge);
    return;
  }
  res.status(403).json({ success: false, message: "Verificación inválida" });
});

/** Firma X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(rawBody, app secret). */
function verifySignature(req: Request): boolean {
  if (!env.META_APP_SECRET) return false; // sin app secret configurado no se acepta nada
  const header = req.header("x-hub-signature-256") ?? "";
  const rawBody: Buffer | undefined = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!header.startsWith("sha256=") || !rawBody) return false;
  const expected = crypto.createHmac("sha256", env.META_APP_SECRET).update(rawBody).digest("hex");
  const received = header.slice("sha256=".length);
  if (received.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(received, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

/**
 * POST /api/meta/webhook — responde 200 de inmediato (Meta reintenta y puede
 * deshabilitar el webhook si la respuesta falla/tarda) y procesa en background,
 * igual que el inbound de SMS Tools.
 */
export const inboundWebhookController = asyncHandler(async (req: Request, res: Response) => {
  if (!verifySignature(req)) {
    res.status(401).json({ success: false, message: "Firma inválida" });
    return;
  }

  const parsed = parseMetaWebhook(req.body);
  res.json({ success: true });

  if (!parsed.messages.length && !parsed.statuses.length) return;
  void processMetaWebhook(parsed).catch((err) => {
    console.error("[meta-webhook] error procesando webhook:", err instanceof Error ? err.message : err);
  });
});
