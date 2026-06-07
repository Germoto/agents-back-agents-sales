import { Request, Response } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/app-error";
import {
  listConversations,
  listConversationMessages,
  setBotPaused,
  sendHumanReply,
  getConversationCustomerPhone,
  notifyOwner,
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
  const conversationId = String(req.params.id);
  const paused = req.body?.paused !== false; // default true
  await setBotPaused(companyId, conversationId, paused);

  // Avisar al WhatsApp del dueño para que pueda atender desde el cel en paralelo.
  const phone = await getConversationCustomerPhone(companyId, conversationId);
  if (phone) {
    const num = phone.replace(/\D/g, "");
    await notifyOwner(
      companyId,
      paused
        ? `🟡 Tomaste el control de ${num} desde la web. El bot está pausado.\n` +
            `Responde desde tu WhatsApp con: *${num} tu mensaje*\nReactivar el bot: *BOT ${num}*`
        : `🟢 Bot reactivado para ${num}. El agente vuelve a responder.`,
    );
  }

  res.json({ success: true, data: { paused } });
});

export const replyConversationController = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  const message = String(req.body?.message ?? "").trim();
  if (!message) throw new AppError("El mensaje no puede estar vacío", 400);
  await sendHumanReply(companyId, String(req.params.id), message);
  res.json({ success: true });
});
