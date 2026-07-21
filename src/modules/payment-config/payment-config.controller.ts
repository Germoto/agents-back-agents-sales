import { Request, Response } from "express";
import { getPaymentConfig, upsertPaymentConfig, updateMercadoPagoConfig, testMercadoPagoConnection } from "./payment-config.service";

export async function getPaymentConfigController(req: Request, res: Response) {
  const config = await getPaymentConfig(req.user!.companyId);
  return res.json(config);
}

export async function upsertPaymentConfigController(req: Request, res: Response) {
  const config = await upsertPaymentConfig(req.user!.companyId, req.body);
  return res.json(config);
}

export async function updateMercadoPagoController(req: Request, res: Response) {
  const result = await updateMercadoPagoConfig(req.user!.companyId, req.body);
  return res.json(result);
}

export async function testMercadoPagoController(req: Request, res: Response) {
  const result = await testMercadoPagoConnection(req.user!.companyId);
  return res.json(result);
}
