import { Request, Response } from "express";
import { asyncHandler } from "../../lib/async-handler";
import {
  listConversations,
  listConversationMessages,
  setBotPaused,
} from "./conversation.service";

export const listConversationsController = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  const conversations = await listConversations(companyId);
  res.json({ success: true, data: conversations });
});

export const listMessagesController = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  const messages = await listConversationMessages(companyId, String(req.params.id));
  res.json({ success: true, data: messages });
});

export const pauseConversationController = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  const paused = req.body?.paused !== false; // default true
  await setBotPaused(companyId, String(req.params.id), paused);
  res.json({ success: true, data: { paused } });
});
