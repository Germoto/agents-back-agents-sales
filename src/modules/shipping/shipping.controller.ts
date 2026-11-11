import { Request, Response } from "express";
import { searchAgencies } from "./agency-search";
import { agencyCatalogStatus } from "./courier-sync.service";
import { getShippingConfig, patchShippingConfig, saveShippingConfig } from "./shipping.service";

export async function getShippingConfigController(req: Request, res: Response) {
  return res.json(await getShippingConfig(req.user!.companyId));
}

export async function saveShippingConfigController(req: Request, res: Response) {
  return res.json(await saveShippingConfig(req.user!.companyId, req.body));
}

export async function patchShippingConfigController(req: Request, res: Response) {
  return res.json(await patchShippingConfig(req.user!.companyId, req.body));
}

export async function searchAgenciesController(req: Request, res: Response) {
  const { q, courier, offset, limit } = req.query as unknown as { q: string; courier?: string; offset: number; limit: number };
  return res.json(await searchAgencies({ query: q, couriers: courier ? [courier] : undefined, offset, limit }));
}

export async function agencyCatalogStatusController(_req: Request, res: Response) {
  return res.json(await agencyCatalogStatus());
}
