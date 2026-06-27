/**
 * Respuestas rápidas del panel de conversaciones.
 *
 * CRUD multi-tenant de plantillas (secuencias de mensajes texto/multimedia) y
 * categorías, más el envío de una secuencia completa a una conversación con
 * auto-pausa del bot (toma de control implícita).
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { loadWhatsappSender, sendText, sendMedia } from "../agent/outbound";
import { applyFirma } from "../agent/firma";
import { recordMessage, setBotPaused } from "../agent/conversation.service";
import { applyCrmAndTagActions } from "../crm/crm.service";
import type { QuickReplyMessageInput, QuickReplyActionsInput } from "./quick-replies.schemas";

const quickReplySelect = {
  id: true,
  title: true,
  command: true,
  categoryId: true,
  category: { select: { id: true, name: true } },
  messages: true,
  actions: true,
  usageCount: true,
  updatedAt: true,
} satisfies Prisma.QuickReplySelect;

/** Normaliza un comando "/saludo": minúsculas, sin barra inicial, vacío => null. */
function normalizeCommand(command: string | null | undefined): string | null {
  if (!command) return null;
  const clean = command.trim().replace(/^\/+/, "").toLowerCase().replace(/\s+/g, "");
  return clean || null;
}

// ---------------------------------------------------------------------------
// Categorías
// ---------------------------------------------------------------------------

export async function listCategories(companyId: string) {
  return prisma.quickReplyCategory.findMany({
    where: { companyId },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, name: true },
  });
}

export async function createCategory(companyId: string, name: string) {
  try {
    return await prisma.quickReplyCategory.create({
      data: { companyId, name },
      select: { id: true, name: true },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new AppError("La categoría ya existe", 409);
    }
    throw err;
  }
}

export async function updateCategory(companyId: string, id: string, name: string) {
  const existing = await prisma.quickReplyCategory.findFirst({ where: { id, companyId } });
  if (!existing) throw new AppError("Categoría no encontrada", 404);
  try {
    return await prisma.quickReplyCategory.update({
      where: { id },
      data: { name },
      select: { id: true, name: true },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new AppError("La categoría ya existe", 409);
    }
    throw err;
  }
}

export async function deleteCategory(companyId: string, id: string) {
  const existing = await prisma.quickReplyCategory.findFirst({ where: { id, companyId } });
  if (!existing) throw new AppError("Categoría no encontrada", 404);
  // onDelete: SetNull → las respuestas rápidas quedan "sin categoría".
  await prisma.quickReplyCategory.delete({ where: { id } });
}

// ---------------------------------------------------------------------------
// Respuestas rápidas (CRUD)
// ---------------------------------------------------------------------------

async function assertCategoryOwned(companyId: string, categoryId: string | null | undefined) {
  if (!categoryId) return;
  const cat = await prisma.quickReplyCategory.findFirst({ where: { id: categoryId, companyId } });
  if (!cat) throw new AppError("Categoría no encontrada", 404);
}

export async function listQuickReplies(companyId: string) {
  return prisma.quickReply.findMany({
    where: { companyId },
    orderBy: { updatedAt: "desc" },
    select: quickReplySelect,
  });
}

type UpsertQuickReplyData = {
  title: string;
  command?: string | null;
  categoryId?: string | null;
  messages: QuickReplyMessageInput[];
  actions?: QuickReplyActionsInput | null;
};

function actionsValue(actions: QuickReplyActionsInput | null | undefined) {
  if (!actions) return Prisma.JsonNull;
  const empty =
    !actions.tagIds?.length && !actions.crmId && !actions.crmColumnId && !actions.markDelivered;
  return empty ? Prisma.JsonNull : (actions as unknown as Prisma.InputJsonValue);
}

export async function createQuickReply(companyId: string, data: UpsertQuickReplyData) {
  await assertCategoryOwned(companyId, data.categoryId);
  try {
    return await prisma.quickReply.create({
      data: {
        companyId,
        title: data.title,
        command: normalizeCommand(data.command),
        categoryId: data.categoryId ?? null,
        messages: data.messages as unknown as Prisma.InputJsonValue,
        actions: actionsValue(data.actions),
      },
      select: quickReplySelect,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new AppError("Ese comando ya está en uso por otra respuesta rápida", 409);
    }
    throw err;
  }
}

export async function updateQuickReply(companyId: string, id: string, data: UpsertQuickReplyData) {
  const existing = await prisma.quickReply.findFirst({ where: { id, companyId } });
  if (!existing) throw new AppError("Respuesta rápida no encontrada", 404);
  await assertCategoryOwned(companyId, data.categoryId);
  try {
    return await prisma.quickReply.update({
      where: { id },
      data: {
        title: data.title,
        command: normalizeCommand(data.command),
        categoryId: data.categoryId ?? null,
        messages: data.messages as unknown as Prisma.InputJsonValue,
        actions: actionsValue(data.actions),
      },
      select: quickReplySelect,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new AppError("Ese comando ya está en uso por otra respuesta rápida", 409);
    }
    throw err;
  }
}

export async function deleteQuickReply(companyId: string, id: string) {
  const existing = await prisma.quickReply.findFirst({ where: { id, companyId } });
  if (!existing) throw new AppError("Respuesta rápida no encontrada", 404);
  await prisma.quickReply.delete({ where: { id } });
}

// ---------------------------------------------------------------------------
// Envío de una respuesta rápida a una conversación
// ---------------------------------------------------------------------------

export interface SendQuickReplyResult {
  sentCount: number;
  total: number;
  failedAtIndex?: number;
}

const SEND_GAP_MS = 500; // pausa entre mensajes para preservar el orden en el gateway

/**
 * Envía la secuencia completa de una respuesta rápida al cliente de la
 * conversación. Solo pausa el bot (toma de control) si `takeControl` es true;
 * así enviar una respuesta rápida NO implica pausar al bot por defecto.
 */
export async function sendQuickReply(
  companyId: string,
  quickReplyId: string,
  conversationId: string,
  takeControl = false,
): Promise<SendQuickReplyResult> {
  const quickReply = await prisma.quickReply.findFirst({
    where: { id: quickReplyId, companyId },
    select: { id: true, messages: true, actions: true },
  });
  if (!quickReply) throw new AppError("Respuesta rápida no encontrada", 404);

  const convo = await prisma.conversation.findFirst({
    where: { id: conversationId, companyId },
    select: { id: true, customerId: true, botPaused: true, customer: { select: { phone: true } } },
  });
  if (!convo) throw new AppError("Conversación no encontrada", 404);

  const sender = await loadWhatsappSender(companyId);
  if (!sender) throw new AppError("No hay una cuenta de WhatsApp activa para enviar", 422);

  const messages = (quickReply.messages as unknown as QuickReplyMessageInput[]) ?? [];
  if (!messages.length) throw new AppError("La respuesta rápida no tiene mensajes", 422);

  // Tomar control solo si se pidió explícitamente (emite CONVERSATION_UPDATED).
  if (takeControl && !convo.botPaused) {
    await setBotPaused(companyId, conversationId, true);
  }

  const to = convo.customer.phone.replace(/\D/g, "");
  let sentCount = 0;
  let failedAtIndex: number | undefined;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    try {
      const text = (await applyFirma(companyId, msg.text)) ?? msg.text ?? null;
      const result =
        msg.type === "text"
          ? await sendText(sender, to, text ?? "")
          : await sendMedia(sender, to, msg.type, msg.mediaUrl ?? "", text ?? undefined, msg.fileName);
      await recordMessage({
        companyId,
        customerId: convo.customerId,
        conversationId,
        role: "ADMIN",
        message: text,
        mediaUrl: msg.type !== "text" ? msg.mediaUrl ?? null : null,
        mediaType: msg.type !== "text" ? msg.type : null,
        gatewayId: result.gatewayId,
      });
      sentCount++;
    } catch (err) {
      failedAtIndex = i;
      console.error(`[quick-replies] fallo enviando mensaje ${i + 1}/${messages.length}`, err);
      break;
    }
    if (i < messages.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, SEND_GAP_MS));
    }
  }

  if (sentCount === 0) {
    throw new AppError("No se pudo enviar la respuesta rápida", 502);
  }

  await prisma.quickReply.update({
    where: { id: quickReplyId },
    data: { usageCount: { increment: 1 } },
  });

  // Acciones post-envío (best-effort): etiquetar al cliente y/o moverlo a un CRM
  await applyQuickReplyActions(
    companyId,
    convo.customerId,
    quickReply.actions as QuickReplyActionsInput | null,
  );

  return { sentCount, total: messages.length, ...(failedAtIndex !== undefined ? { failedAtIndex } : {}) };
}

/** Etiqueta al cliente y/o lo mueve a una pestaña de un CRM tras enviar. */
async function applyQuickReplyActions(
  companyId: string,
  customerId: string,
  actions: QuickReplyActionsInput | null,
): Promise<void> {
  if (!actions) return;
  await applyCrmAndTagActions(companyId, customerId, {
    tagIds: actions.tagIds,
    crmId: actions.crmId,
    crmColumnId: actions.crmColumnId,
  });
}
