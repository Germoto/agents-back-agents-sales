/**
 * CRUD de recordatorios/seguimientos programados (ScheduledMessage).
 * El worker (scheduler.worker.ts) los consume; el agente los crea/cancela.
 */

import { Prisma, ScheduledMessageType, ScheduledMessageStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";

export async function scheduleReminder(opts: {
  companyId: string;
  customerId: string;
  conversationId?: string | null;
  type: ScheduledMessageType;
  sendAt: Date;
  body: string;
  mediaUrl?: string | null;
  metadata?: Prisma.InputJsonValue;
}): Promise<void> {
  // Permitir recordatorios solo-multimedia (sin texto): basta con body o mediaUrl.
  if (!opts.body.trim() && !opts.mediaUrl) return;
  await prisma.scheduledMessage.create({
    data: {
      companyId: opts.companyId,
      customerId: opts.customerId,
      conversationId: opts.conversationId ?? null,
      type: opts.type,
      sendAt: opts.sendAt,
      body: opts.body,
      mediaUrl: opts.mediaUrl ?? null,
      ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
    },
  });
}

/**
 * Cancela recordatorios PENDING de un cliente (evita follow-ups obsoletos
 * cuando el cliente vuelve a responder). Si se pasan tipos, solo esos.
 */
export async function cancelPendingReminders(
  companyId: string,
  customerId: string,
  types?: ScheduledMessageType[],
): Promise<void> {
  await prisma.scheduledMessage.updateMany({
    where: {
      companyId,
      customerId,
      status: ScheduledMessageStatus.PENDING,
      ...(types && types.length ? { type: { in: types } } : {}),
    },
    data: { status: ScheduledMessageStatus.CANCELLED },
  });
}

export function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}

export function secondsFromNow(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}
