/**
 * CRUD de recordatorios/seguimientos programados (ScheduledMessage).
 * El worker (scheduler.worker.ts) los consume; el agente los crea/cancela.
 */

import { Prisma, ScheduledMessageType, ScheduledMessageStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { clampToBusinessHours, normalizeQuietHours, type QuietHours } from "./quiet-hours";

export async function scheduleReminder(opts: {
  companyId: string;
  customerId: string;
  conversationId?: string | null;
  type: ScheduledMessageType;
  sendAt: Date;
  body: string;
  mediaUrl?: string | null;
  metadata?: Prisma.InputJsonValue;
  // Si se pasa timezone, el sendAt se clampea a la ventana de horario hábil del
  // tenant (quietHours, default 7-23): nada de recordatorios de madrugada.
  timezone?: string | null;
  quietHours?: QuietHours | unknown;
}): Promise<void> {
  // Permitir recordatorios solo-multimedia (sin texto): basta con body o mediaUrl.
  if (!opts.body.trim() && !opts.mediaUrl) return;
  let sendAt = opts.sendAt;
  if (opts.timezone) {
    sendAt = clampToBusinessHours(sendAt, opts.timezone, normalizeQuietHours(opts.quietHours));
  }
  await prisma.scheduledMessage.create({
    data: {
      companyId: opts.companyId,
      customerId: opts.customerId,
      conversationId: opts.conversationId ?? null,
      type: opts.type,
      sendAt,
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

/**
 * Agenda un reintento de validación de pago (2º plano). El worker, al vencer,
 * re-corre el matching: si aparece el comprobante, aprueba y entrega; si no,
 * deriva a un asesor humano. No es un mensaje al cliente (body vacío).
 */
export async function schedulePaymentRecheck(opts: {
  companyId: string;
  customerId: string;
  conversationId: string;
  sendAt: Date;
  payerName?: string | null;
  expectedAmount?: number | null;
  operationCode?: string | null;
  customerPhone: string;
  receiptMediaUrl?: string | null;
}): Promise<void> {
  await prisma.scheduledMessage.create({
    data: {
      companyId: opts.companyId,
      customerId: opts.customerId,
      conversationId: opts.conversationId,
      type: ScheduledMessageType.PAYMENT_RECHECK,
      sendAt: opts.sendAt,
      body: "",
      metadata: {
        kind: "payment-recheck",
        payerName: opts.payerName ?? null,
        expectedAmount: opts.expectedAmount ?? null,
        operationCode: opts.operationCode ?? null,
        customerPhone: opts.customerPhone,
        receiptMediaUrl: opts.receiptMediaUrl ?? null,
      } as Prisma.InputJsonValue,
    },
  });
}

export function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}

export function secondsFromNow(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}
