import type { Request, Response } from "express";
import type { StoreOrderStatus } from "@prisma/client";
import { AppError } from "../../lib/app-error";
import {
  approveStoreOrder,
  createStoreCheckout,
  getPublicOrder,
  getPublicStore,
  getStoreOgHtml,
  getStorefrontConfig,
  listStoreOrders,
  rejectStoreOrder,
  submitStoreReceipt,
  tlsAsk,
  updateStorefrontConfig,
} from "./storefront.service";
import { storeReceiptPublicUrl, type StoreOrderRequest } from "./storefront-upload.middleware";

// ---------------- Público ----------------

export async function tlsAskController(req: Request, res: Response) {
  const domain = String(req.query.domain ?? "");
  const ok = domain ? await tlsAsk(domain) : false;
  return res.status(ok ? 200 : 404).send(ok ? "ok" : "not found");
}

/** Preview Open Graph para bots (Caddy reescribe aquí las visitas de WhatsApp/Meta/Telegram). */
export async function storeOgController(req: Request, res: Response) {
  const host = String(req.query.host ?? req.headers["x-forwarded-host"] ?? req.headers.host ?? "");
  const path = String(req.query.path ?? "/");
  const html = await getStoreOgHtml(host, path);
  if (!html) return res.status(404).type("text/plain").send("not found");
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.type("text/html").send(html);
}

export async function getPublicStoreController(req: Request, res: Response) {
  return res.json(await getPublicStore(String(req.params.slug)));
}

export async function storeCheckoutController(req: Request, res: Response) {
  const b = req.body as { fbp?: string | null; fbc?: string | null; pageUrl?: string | null };
  const client = {
    ip: req.ip ?? null,
    ua: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 300) : null,
    fbp: b.fbp ?? null,
    fbc: b.fbc ?? null,
    url: b.pageUrl ?? null,
  };
  return res.status(201).json(await createStoreCheckout(String(req.params.slug), req.body, client));
}

export async function getPublicOrderController(req: Request, res: Response) {
  return res.json(await getPublicOrder(String(req.params.id), String(req.query.t ?? "")));
}

/** Comprobante Yape/Plin del comprador (multipart `file` + `payerName`). El pedido ya fue validado por storeOrderAccess. */
export async function storeReceiptController(req: Request, res: Response) {
  const order = (req as StoreOrderRequest).storeOrder;
  if (!order) throw new AppError("Pedido no encontrado", 404);
  if (!req.file) throw new AppError("Sube la captura del comprobante", 400);
  const payerName = typeof req.body?.payerName === "string" ? req.body.payerName : null;
  const mediaUrl = storeReceiptPublicUrl(order.companyId, req.file.filename);
  return res.json(await submitStoreReceipt(order.id, { mediaUrl, payerName }));
}

// ---------------- Panel ----------------

export async function getStorefrontConfigController(req: Request, res: Response) {
  return res.json(await getStorefrontConfig(req.user!.companyId));
}

export async function updateStorefrontConfigController(req: Request, res: Response) {
  return res.json(await updateStorefrontConfig(req.user!.companyId, req.body));
}

export async function listStoreOrdersController(req: Request, res: Response) {
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 25;
  const status = (req.query.status as StoreOrderStatus | undefined) || undefined;
  return res.json(await listStoreOrders(req.user!.companyId, page, limit, status));
}

export async function approveStoreOrderController(req: Request, res: Response) {
  return res.json(await approveStoreOrder(req.user!.companyId, String(req.params.id), req.body ?? {}));
}

export async function rejectStoreOrderController(req: Request, res: Response) {
  return res.json(await rejectStoreOrder(req.user!.companyId, String(req.params.id), req.body ?? {}));
}
