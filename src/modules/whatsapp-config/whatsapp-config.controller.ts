import { Request, Response } from "express";
import { getWhatsappConfig, testWhatsappConnection, upsertWhatsappConfig } from "./whatsapp-config.service";

export async function getWhatsappConfigController(req: Request, res: Response) {
  const config = await getWhatsappConfig(req.user!.companyId);
  return res.json(config);
}

export async function upsertWhatsappConfigController(req: Request, res: Response) {
  const config = await upsertWhatsappConfig(req.user!.companyId, req.body);
  return res.json(config);
}

export async function testWhatsappConnectionController(req: Request, res: Response) {
  const result = await testWhatsappConnection(req.body);
  return res.json(result);
}
