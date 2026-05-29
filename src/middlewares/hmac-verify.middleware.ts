import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";

/**
 * Middleware para webhooks entrantes.
 *
 * Para source = "validpay":
 *   Header: X-Validpay-Signature: t=<timestamp>,v1=<hmac_body>,v2=<hmac_ts.body>
 *   Verifica v1 = HMAC-SHA256(bodyStr, secret)  ó
 *            v2 = HMAC-SHA256("<timestamp>.<bodyStr>", secret)
 *
 * Para otros sources:
 *   Header: X-Webhook-Signature: sha256=<hex>
 *   Verifica HMAC-SHA256(rawBody, secret)
 *
 * Si hay múltiples endpoints activos para la misma company itera sobre todos.
 */
export async function hmacVerify(req: Request, res: Response, next: NextFunction) {
  const companyId = req.params.companyId ? String(req.params.companyId) : "";
  if (!companyId) {
    res.status(400).json({ success: false, error: "companyId requerido" });
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

  let matched = null;

  for (const endpoint of endpoints) {
    if (endpoint.source === "validpay") {
      matched = verifyValidpay(req, endpoint) ? endpoint : null;
    } else {
      matched = verifyGeneric(req, rawBody, endpoint) ? endpoint : null;
    }
    if (matched) break;
  }

  if (!matched) {
    res.status(401).json({ success: false, error: "Firma inválida" });
    return;
  }

  (req as any).webhookEndpoint = matched;
  next();
}

/** Verifica firma ValidPay: X-Validpay-Signature: t=...,v1=...,v2=... */
function verifyValidpay(req: Request, endpoint: { secret: string }): boolean {
  const header = req.headers["x-validpay-signature"] as string | undefined;
  if (!header) return false;

  // Parsear: t=1234,v1=abc,v2=def
  const parts: Record<string, string> = {};
  for (const part of header.split(",")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    parts[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }

  const rawBody: Buffer = (req as any).rawBody;
  const bodyStr = rawBody.toString("utf8");
  const secret = endpoint.secret;

  // v2: HMAC("<timestamp>.<body>", secret)
  if (parts.t && parts.v2) {
    const expected = crypto.createHmac("sha256", secret)
      .update(`${parts.t}.${bodyStr}`)
      .digest("hex");
    if (safeEqual(parts.v2, expected)) return true;
  }

  // v1 compat: HMAC(body, secret)
  if (parts.v1) {
    const expected = crypto.createHmac("sha256", secret)
      .update(bodyStr)
      .digest("hex");
    if (safeEqual(parts.v1, expected)) return true;
  }

  return false;
}

/** Verifica firma genérica: X-Webhook-Signature: sha256=<hex> */
function verifyGeneric(req: Request, rawBody: Buffer, endpoint: { secret: string }): boolean {
  const signature = req.headers["x-webhook-signature"] as string | undefined;
  if (!signature || !signature.startsWith("sha256=")) return false;

  const received = signature.slice(7);
  const expected = crypto.createHmac("sha256", endpoint.secret)
    .update(rawBody)
    .digest("hex");

  return safeEqual(received, expected);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}
