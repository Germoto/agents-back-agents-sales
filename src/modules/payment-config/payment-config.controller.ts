import { Request, Response } from "express";
import { getPaymentConfig, upsertPaymentConfig } from "./payment-config.service";

export async function getPaymentConfigController(req: Request, res: Response) {
  const config = await getPaymentConfig(req.user!.companyId);
  return res.json(config);
}

export async function upsertPaymentConfigController(req: Request, res: Response) {
  const config = await upsertPaymentConfig(req.user!.companyId, req.body);
  return res.json(config);
}
