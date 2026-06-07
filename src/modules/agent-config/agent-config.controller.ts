import { Request, Response } from "express";
import {
  getAgentConfig,
  upsertAgentConfig,
  updateAgentReminders,
  updateAgentReplyMode,
} from "./agent-config.service";

export async function getAgentConfigController(req: Request, res: Response) {
  const config = await getAgentConfig(req.user!.companyId);
  return res.json(config);
}

export async function upsertAgentConfigController(req: Request, res: Response) {
  const config = await upsertAgentConfig(req.user!.companyId, req.body);
  return res.json(config);
}

export async function updateRemindersController(req: Request, res: Response) {
  const config = await updateAgentReminders(req.user!.companyId, req.body.followupConfig ?? null);
  return res.json(config);
}

export async function updateReplyModeController(req: Request, res: Response) {
  const config = await updateAgentReplyMode(
    req.user!.companyId,
    req.body.replyMode,
    req.body.testNumbers ?? [],
  );
  return res.json(config);
}
