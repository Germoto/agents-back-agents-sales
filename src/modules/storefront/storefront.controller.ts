import type { Request, Response } from "express";
import type { StoreOrderStatus } from "@prisma/client";
import { AppError } from "../../lib/app-error";
import {
  approveStoreOrder,
  createCoupon,
  createStoreCheckout,
  deleteCoupon,
  listCoupons,
  previewCoupon,
  updateCoupon,
  getPublicOrder,
  getPublicStore,
  getStoreOgHtml,
  getStorefrontConfig,
  listStoreOrders,
  recordStoreEvents,
  rejectStoreOrder,
  storeMetrics,
  submitStoreReceipt,
  tlsAsk,
  updateStorefrontConfig,
} from "./storefront.service";
import { storeReceiptPublicUrl, type StoreOrderRequest } from "./storefront-upload.middleware";
import { listStoreEmails, sendStoreTestEmail, subscribeToStore, unsubscribeByToken } from "./storefront-email.service";
import { cancelCampaign, createCampaign, deleteCampaign, duplicateCampaign, getCampaign, listCampaigns, listEmailTags, previewAudience, searchEmailContacts, sendCampaignTest, startCampaign, updateCampaign } from "./storefront-campaigns.service";
import { prisma } from "../../lib/prisma";

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
  const b = req.body as { fbp?: string | null; fbc?: string | null; pageUrl?: string | null; sessionId?: string | null };
  const client = {
    ip: req.ip ?? null,
    ua: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 300) : null,
    fbp: b.fbp ?? null,
    fbc: b.fbc ?? null,
    url: b.pageUrl ?? null,
    sessionId: b.sessionId ?? null,
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

export async function storeEventsController(req: Request, res: Response) {
  const body = req.body as { sessionId: string; events: { type: string; productId?: string | null; campaignId?: string | null }[] };
  return res.json(await recordStoreEvents(String(req.params.slug), body.sessionId, body.events));
}

export async function storeCouponPreviewController(req: Request, res: Response) {
  const body = req.body as { code: string; productIds: string[] };
  return res.json(await previewCoupon(String(req.params.slug), body.code, body.productIds));
}

/** Suscripción al boletín de la tienda (pie). */
export async function storeSubscribeController(req: Request, res: Response) {
  const slug = String(req.params.slug ?? "").trim().toLowerCase();
  const company = await prisma.company.findUnique({ where: { slug }, select: { id: true, isActive: true } });
  if (!company || !company.isActive) throw new AppError("Tienda no encontrada", 404);
  const body = req.body as { email: string; name?: string | null };
  return res.json(await subscribeToStore(company.id, body));
}

/** Página mínima de baja (enlace "Darme de baja" de los correos). */
export async function storeUnsubController(req: Request, res: Response) {
  const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
  try {
    const r = await unsubscribeByToken(String(req.query.t ?? ""));
    return res.type("text/html").send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Baja confirmada</title></head><body style="margin:0;background:#f6f5f2;font-family:Arial,sans-serif;color:#17151f"><div style="max-width:480px;margin:60px auto;background:#fff;border:1px solid #e7e4de;border-radius:18px;padding:32px;text-align:center"><div style="font-size:40px">✓</div><h1 style="font-size:22px;margin:12px 0 8px">Listo, no recibirás más correos de ${esc(r.storeName)}</h1><p style="color:#6b6775;font-size:14px;margin:0 0 20px">Si fue un error, puedes volver a suscribirte desde la tienda.</p>${r.storeLink ? `<a href="${esc(r.storeLink)}" style="display:inline-block;background:#5b34e0;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:12px">Ir a la tienda</a>` : ""}</div></body></html>`);
  } catch (err) {
    const msg = err instanceof AppError ? err.message : "El enlace no es válido";
    return res.status(400).type("text/html").send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Enlace inválido</title></head><body style="font-family:Arial,sans-serif;padding:40px;text-align:center"><h1 style="font-size:20px">${esc(msg)}</h1></body></html>`);
  }
}

// ---------------- Panel ----------------

export async function listStoreEmailsController(req: Request, res: Response) {
  const kind = (req.query.kind as string | undefined) || undefined;
  const limit = Number(req.query.limit) || 50;
  return res.json(await listStoreEmails(req.user!.companyId, kind, limit));
}

export async function storeEmailTestController(req: Request, res: Response) {
  return res.json(await sendStoreTestEmail(req.user!.companyId, req.body));
}

export async function listCouponsController(req: Request, res: Response) {
  return res.json(await listCoupons(req.user!.companyId));
}
export async function createCouponController(req: Request, res: Response) {
  return res.status(201).json(await createCoupon(req.user!.companyId, req.body));
}
export async function updateCouponController(req: Request, res: Response) {
  return res.json(await updateCoupon(req.user!.companyId, String(req.params.id), req.body));
}
export async function deleteCouponController(req: Request, res: Response) {
  return res.json(await deleteCoupon(req.user!.companyId, String(req.params.id)));
}

export async function storeMetricsController(req: Request, res: Response) {
  return res.json(await storeMetrics(req.user!.companyId, Number(req.query.days) || 30));
}

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

// ---------------- Panel: campañas de correo ----------------

export async function listCampaignsController(req: Request, res: Response) {
  return res.json(await listCampaigns(req.user!.companyId));
}
export async function getCampaignController(req: Request, res: Response) {
  return res.json(await getCampaign(req.user!.companyId, String(req.params.id)));
}
export async function createCampaignController(req: Request, res: Response) {
  return res.status(201).json(await createCampaign(req.user!.companyId, req.body));
}
export async function updateCampaignController(req: Request, res: Response) {
  return res.json(await updateCampaign(req.user!.companyId, String(req.params.id), req.body));
}
export async function deleteCampaignController(req: Request, res: Response) {
  return res.json(await deleteCampaign(req.user!.companyId, String(req.params.id)));
}
export async function duplicateCampaignController(req: Request, res: Response) {
  return res.status(201).json(await duplicateCampaign(req.user!.companyId, String(req.params.id)));
}
export async function previewAudienceController(req: Request, res: Response) {
  return res.json(await previewAudience(req.user!.companyId, (req.body as { audience: unknown }).audience));
}
export async function campaignTestController(req: Request, res: Response) {
  return res.json(await sendCampaignTest(req.user!.companyId, String(req.params.id), (req.body as { to: string }).to));
}
export async function startCampaignController(req: Request, res: Response) {
  return res.json(await startCampaign(req.user!.companyId, String(req.params.id), req.body ?? {}));
}
export async function cancelCampaignController(req: Request, res: Response) {
  return res.json(await cancelCampaign(req.user!.companyId, String(req.params.id)));
}
export async function emailContactsController(req: Request, res: Response) {
  return res.json(await searchEmailContacts(req.user!.companyId, String(req.query.q ?? ""), Number(req.query.limit) || 30));
}
export async function emailTagsController(req: Request, res: Response) {
  return res.json(await listEmailTags(req.user!.companyId));
}
