import { Request, Response } from "express";
import { ScheduledMessageType } from "@prisma/client";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/app-error";
import {
  listConversationsPage,
  getConversationSummary,
  listConversationMessages,
  setBotPaused,
  sendHumanReply,
  sendHumanMedia,
  reactToMessage,
  sendTypingState,
  startConversation,
  getConversationCustomerPhone,
  getConversationCustomerId,
  resetConversation,
  deleteConversation,
  deleteConversations,
  notifyOwner,
  scheduleManualReminder,
  setConversationPinned,
  setCustomerOptOut,
} from "./conversation.service";
import { cancelPendingReminders } from "../scheduler/scheduler.service";

export const listConversationsController = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  const q = req.query as {
    q?: string;
    status?: string;
    tagId?: string;
    adSourceId?: string;
    sortBy?: "last" | "opened";
    dir?: "asc" | "desc";
    offset?: number;
    limit?: number;
  };
  const page = await listConversationsPage(companyId, q);
  // `data` sigue siendo el array (compat); total/hasMore/nextOffset van al lado.
  res.json({ success: true, data: page.items, total: page.total, hasMore: page.hasMore, nextOffset: page.nextOffset });
});

export const getConversationController = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  const conversation = await getConversationSummary(companyId, String(req.params.id));
  if (!conversation) throw new AppError("Conversación no encontrada", 404);
  res.json({ success: true, data: conversation });
});

export const listMessagesController = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  const q = req.query as { before?: string; limit?: number };
  const page = await listConversationMessages(companyId, String(req.params.id), { before: q.before, limit: q.limit });
  res.json({ success: true, data: page.items, hasMore: page.hasMore });
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

/** Fijar / desfijar un chat en la lista (sin límite de fijados). */
export const pinConversationController = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  const pinned = req.body?.pinned !== false; // default true
  const r = await setConversationPinned(companyId, String(req.params.id), pinned);
  res.json({ success: true, data: { pinned, pinnedAt: r.pinnedAt } });
});

/** Marcar / desmarcar al cliente del chat como "no contactar". Al marcar, pausa el bot. */
export const optOutConversationController = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  const conversationId = String(req.params.id);
  const optOut = req.body?.optOut !== false; // default true
  const customerId = await getConversationCustomerId(companyId, conversationId);
  if (!customerId) throw new AppError("Conversación no encontrada", 404);
  const r = await setCustomerOptOut(companyId, customerId, optOut, { pauseBot: true, reason: "marcado desde el panel" });
  res.json({ success: true, data: { optOut, cancelled: r.cancelled } });
});

export const scheduleReminderController = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  const conversationId = String(req.params.id);
  const message = String(req.body?.message ?? "").trim();
  const mediaUrl = req.body?.mediaUrl ? String(req.body.mediaUrl) : null;
  // Acepta sendAt (ISO) o delayMinutes (relativo a ahora).
  let sendAt: Date;
  if (req.body?.sendAt) {
    sendAt = new Date(String(req.body.sendAt));
  } else if (req.body?.delayMinutes != null) {
    sendAt = new Date(Date.now() + Number(req.body.delayMinutes) * 60 * 1000);
  } else {
    throw new AppError("Falta la fecha del recordatorio (sendAt o delayMinutes)", 400);
  }
  await scheduleManualReminder(companyId, conversationId, {
    message,
    sendAt,
    mediaUrl,
    mediaType: req.body?.mediaType ? String(req.body.mediaType) : null,
  });
  res.json({ success: true });
});

export const replyConversationController = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  const message = String(req.body?.message ?? "").trim();
  const mediaUrl = req.body?.mediaUrl ? String(req.body.mediaUrl) : null;
  if (!message && !mediaUrl) throw new AppError("El mensaje no puede estar vacío", 400);
  if (mediaUrl) {
    const kindRaw = String(req.body?.mediaKind ?? "image");
    const mediaKind = (["image", "video", "audio", "document"].includes(kindRaw) ? kindRaw : "image") as
      | "image"
      | "video"
      | "audio"
      | "document";
    await sendHumanMedia(companyId, String(req.params.id), {
      mediaUrl,
      mediaKind,
      caption: message || undefined,
      fileName: req.body?.fileName ? String(req.body.fileName) : undefined,
    });
  } else {
    await sendHumanReply(companyId, String(req.params.id), message, {
      quoteMessageId: req.body?.quoteMessageId ? String(req.body.quoteMessageId) : null,
    });
  }
  res.json({ success: true });
});

export const typingConversationController = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  const raw = String(req.body?.state ?? "").toLowerCase();
  const state = raw === "composing" || raw === "recording" ? raw : "paused";
  // Best-effort: el service nunca lanza; el panel no debe ver errores por typing.
  await sendTypingState(companyId, String(req.params.id), state);
  res.json({ success: true });
});

export const reactConversationController = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  const messageId = String(req.body?.messageId ?? "").trim();
  if (!messageId) throw new AppError("Falta el mensaje a reaccionar (messageId)", 400);
  // emoji "" = quitar la reacción existente.
  const emoji = String(req.body?.emoji ?? "");
  await reactToMessage(companyId, String(req.params.id), messageId, emoji);
  res.json({ success: true });
});

export const startConversationController = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  const phone = String(req.body?.phone ?? "").trim();
  const message = String(req.body?.message ?? "").trim();
  if (!phone) throw new AppError("Ingresa el número del cliente", 400);
  if (!message) throw new AppError("El mensaje no puede estar vacío", 400);
  const result = await startConversation(companyId, phone, message);
  res.json({ success: true, data: result });
});

export const deleteConversationController = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  await deleteConversation(companyId, String(req.params.id));
  res.json({ success: true });
});

// Eliminación masiva: borra las conversaciones que pasen los guards (pago) y
// reporta las omitidas con su motivo.
export const deleteConversationsBulkController = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  const ids = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).map(String) : [];
  if (!ids.length) throw new AppError("No se enviaron conversaciones a eliminar", 400);
  const result = await deleteConversations(companyId, ids);
  res.json({ success: true, ...result });
});

// Reset desde el panel: igual que el comando "reset" del cliente (borra historial,
// carrito y estado, reactiva el bot) + cancela los recordatorios pendientes.
export const resetConversationController = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  const conversationId = String(req.params.id);
  const customerId = await getConversationCustomerId(companyId, conversationId);
  if (!customerId) throw new AppError("Conversación no encontrada", 404);
  await resetConversation(companyId, conversationId, customerId);
  await cancelPendingReminders(companyId, customerId, [
    ScheduledMessageType.ABANDONED_CART,
    ScheduledMessageType.LEFT_ON_READ,
    ScheduledMessageType.OFFER_COUNTDOWN,
    ScheduledMessageType.POST_SALE,
    ScheduledMessageType.CUSTOM,
  ]);
  res.json({ success: true });
});
