import { Request, Response } from "express";
import {
  createSession,
  getSessionHistory,
  postVisitorMessage,
  getWebchatConfig,
  updateWebchatConfig,
  regenerateWebchatToken,
} from "./webchat.service";
import type { WebchatRequest } from "./webchat-auth.middleware";

// --- Público (visitantes del widget) ---

export async function createSessionController(req: Request, res: Response) {
  res.json(await createSession(req.body));
}

export async function getHistoryController(req: WebchatRequest, res: Response) {
  res.json(await getSessionHistory(req.webchat!));
}

export async function postMessageController(req: WebchatRequest, res: Response) {
  res.json(await postVisitorMessage(req.webchat!, req.body.message));
}

// --- Panel (config Chat Web del tenant) ---

export async function getWebchatConfigController(req: Request, res: Response) {
  res.json(await getWebchatConfig(req.user!.companyId));
}

export async function updateWebchatConfigController(req: Request, res: Response) {
  res.json(await updateWebchatConfig(req.user!.companyId, req.body));
}

export async function regenerateTokenController(req: Request, res: Response) {
  res.json(await regenerateWebchatToken(req.user!.companyId));
}
