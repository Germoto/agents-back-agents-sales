import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";

/**
 * Middleware para webhooks entrantes.
 *
 * Extrae companyId de req.params.companyId, carga todos los WebhookEndpoint
 * activos de esa company y valida la firma HMAC-SHA256 enviada en el header
 * X-Webhook-Signature (formato: "sha256=<hex>").
 *
 * Si hay múltiples endpoints activos para la misma company (ej. dos fuentes
 * distintas o dos cuentas del mismo proveedor) itera sobre todos y acepta si
 * alguno coincide.
 *
 * En caso de éxito adjunta req.webhookEndpoint para que el controller lo use.
 */
export async function hmacVerify(req: Request, res: Response, next: NextFunction) {
  const companyId = req.params.companyId ? String(req.params.companyId) : "";
  if (!companyId) {
    res.status(400).json({ success: false, error: "companyId requerido" });
    return;
  }

  const signature = req.headers["x-webhook-signature"] as string | undefined;
  if (!signature || !signature.startsWith("sha256=")) {
    res.status(401).json({ success: false, error: "X-Webhook-Signature ausente o con formato incorrecto" });
    return;
  }

  const rawBody: Buffer = (req as any).rawBody;
  if (!rawBody) {
    res.status(500).json({ success: false, error: "rawBody no disponible" });
    return;
  }

  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { companyId, active: true },
  });

  if (endpoints.length === 0) {
    res.status(401).json({ success: false, error: "No hay endpoints activos para esta company" });
    return;
  }

  const received = signature.slice(7); // quitar "sha256="

  let matched = null;
  for (const endpoint of endpoints) {
    const expected = crypto
      .createHmac("sha256", endpoint.secret)
      .update(rawBody)
      .digest("hex");
    // Comparación en tiempo constante para prevenir timing attacks
    if (
      received.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(received, "hex"), Buffer.from(expected, "hex"))
    ) {
      matched = endpoint;
      break;
    }
  }

  if (!matched) {
    res.status(401).json({ success: false, error: "Firma inválida" });
    return;
  }

  (req as any).webhookEndpoint = matched;
  next();
}
