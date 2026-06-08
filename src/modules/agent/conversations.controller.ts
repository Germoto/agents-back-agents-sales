import { Request, Response } from "express";
import { ScheduledMessageType } from "@prisma/client";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/app-error";
import {
  listConversations,
  listConversationMessages,
  setBotPaused,
  sendHumanReply,
  getConversationCustomerPhone,
  getConversationCustomerId,
  setConversationState,
  resetConversation,
  notifyOwner,
} from "./conversation.service";
import { cancelPendingReminders } from "../scheduler/scheduler.service";

// Etapas del embudo que un admin puede setear a mano (state.status).
const SETTABLE_FUNNEL_STATUSES = [
  "NUEVO",
  "ESPERANDO_PAGO",
  "ESPERANDO_VALIDACION",
  "PAGADO",
  "ENTREGADO",
  "PEDIDO_REGISTRADO",
  "RESERVA_SOLICITADA",
  "ASESOR_HUMANO",
];

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

// Setear/corregir el estado del embudo (state.status) sin borrar el historial.
export const setStateController = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.user!.companyId;
  const conversationId = String(req.params.id);
  const status = req.body?.status as string | undefined;
  const clearSelectedProduct = req.body?.clearSelectedProduct === true;
  if (status !== undefined && !SETTABLE_FUNNEL_STATUSES.includes(status)) {
    throw new AppError("Estado no válido", 400);
  }
  if (status === undefined && !clearSelectedProduct) {
    throw new AppError("Nada que actualizar", 400);
  }
  const state = await setConversationState(companyId, conversationId, { status, clearSelectedProduct });
  res.json({ success: true, data: { status: state.status ?? null } });
});
