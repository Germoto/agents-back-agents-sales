import { Request, Response } from "express";
import { getAgentConfig, upsertAgentConfig } from "./agent-config.service";

export async function getAgentConfigController(req: Request, res: Response) {
  const config = await getAgentConfig(req.user!.companyId);
  return res.json(config);
}

export async function upsertAgentConfigController(req: Request, res: Response) {
  const config = await upsertAgentConfig(req.user!.companyId, req.body);
  return res.json(config);
}
