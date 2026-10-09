import type { Request, Response } from "express";
import {
  createStoreCheckout,
  getPublicOrder,
  getPublicStore,
  getStorefrontConfig,
  listStoreOrders,
  tlsAsk,
  updateStorefrontConfig,
} from "./storefront.service";

// ---------------- Público ----------------

export async function tlsAskController(req: Request, res: Response) {
  const domain = String(req.query.domain ?? "");
  const ok = domain ? await tlsAsk(domain) : false;
  return res.status(ok ? 200 : 404).send(ok ? "ok" : "not found");
}

export async function getPublicStoreController(req: Request, res: Response) {
  return res.json(await getPublicStore(String(req.params.slug)));
}

export async function storeCheckoutController(req: Request, res: Response) {
  return res.status(201).json(await createStoreCheckout(String(req.params.slug), req.body));
}

export async function getPublicOrderController(req: Request, res: Response) {
  return res.json(await getPublicOrder(String(req.params.id), String(req.query.t ?? "")));
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
  return res.json(await listStoreOrders(req.user!.companyId, page, limit));
}
