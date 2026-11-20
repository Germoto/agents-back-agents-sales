import { Request, Response } from "express";
import {
  getAgentConfig,
  upsertAgentConfig,
  updateAgentReminders,
  updateAgentMutedNumbers,
  updateAgentReplyMode,
  listAgentVoices,
  testAgentVoice,
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

export async function updateMutedNumbersController(req: Request, res: Response) {
  const config = await updateAgentMutedNumbers(
    req.user!.companyId,
    req.body.mutedNumbers ?? [],
    req.body.muteAfterSale,
  );
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

/** La clave recién escrita (aún sin guardar) viaja en una cabecera, nunca en la URL. */
function typedVoiceKey(req: Request): string | undefined {
  const raw = req.headers["x-voice-key"];
  return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 200) : undefined;
}

export async function listAgentVoicesController(req: Request, res: Response) {
  return res.json(await listAgentVoices(req.user!.companyId, typedVoiceKey(req)));
}

export async function testAgentVoiceController(req: Request, res: Response) {
  return res.json(await testAgentVoice(req.user!.companyId, req.body, typedVoiceKey(req)));
}
