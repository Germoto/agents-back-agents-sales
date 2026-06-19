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
 *
 * Los recordatorios MANUALES (programados por un humano desde el panel, con
 * metadata.manual=true) NO se cancelan automáticamente. OJO: el filtro de Prisma
 * `NOT: { metadata: { path: ["manual"], equals: true } }` NO sirve aquí — para las
 * filas cuyo metadata NO tiene la clave "manual" (todos los recordatorios
 * automáticos), el path es NULL y `NOT NULL` es NULL, así que la fila NO matchea y
 * NO se cancela (la cancelación quedaba sin efecto → recordatorios duplicados/spam).
 * Por eso filtramos los manuales en JS y cancelamos por lista de ids.
 */
export async function cancelPendingReminders(
  companyId: string,
  customerId: string,
  types?: ScheduledMessageType[],
): Promise<void> {
  const rows = await prisma.scheduledMessage.findMany({
    where: {
      companyId,
      customerId,
      status: ScheduledMessageStatus.PENDING,
      ...(types && types.length ? { type: { in: types } } : {}),
    },
    select: { id: true, metadata: true },
  });
  const isManual = (m: unknown) =>
    !!m && typeof m === "object" && !Array.isArray(m) && (m as Record<string, unknown>).manual === true;
  const ids = rows.filter((r) => !isManual(r.metadata)).map((r) => r.id);
  if (!ids.length) return;
  await prisma.scheduledMessage.updateMany({
    where: { id: { in: ids } },
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

/** Tipos de recordatorio "de seguimiento" (visibles/gestionables en el panel). */
export const FOLLOWUP_TYPES: ScheduledMessageType[] = [
  ScheduledMessageType.ABANDONED_CART,
  ScheduledMessageType.LEFT_ON_READ,
  ScheduledMessageType.OFFER_COUNTDOWN,
  ScheduledMessageType.POST_SALE,
  ScheduledMessageType.CUSTOM,
];

/** Cancela un recordatorio PENDING puntual (filtrando por empresa). Devuelve si canceló. */
export async function cancelReminderById(companyId: string, id: string): Promise<boolean> {
  const res = await prisma.scheduledMessage.updateMany({
    where: { id, companyId, status: ScheduledMessageStatus.PENDING },
    data: { status: ScheduledMessageStatus.CANCELLED },
  });
  return res.count > 0;
}

/**
 * Cancela en lote varios recordatorios PENDING por id (selección masiva desde el panel).
 * Filtra por empresa y solo PENDING; devuelve cuántos canceló.
 */
export async function cancelRemindersByIds(companyId: string, ids: string[]): Promise<number> {
  const clean = [...new Set(ids.map((s) => String(s).trim()).filter(Boolean))];
  if (!clean.length) return 0;
  const res = await prisma.scheduledMessage.updateMany({
    where: { id: { in: clean }, companyId, status: ScheduledMessageStatus.PENDING },
    data: { status: ScheduledMessageStatus.CANCELLED },
  });
  return res.count;
}

/**
 * Lista los recordatorios de seguimiento PENDING de una empresa (panel "Programados").
 * Excluye los internos (FLOW_TIMEOUT, PAYMENT_RECHECK). Filtro opcional por tipo y por
 * texto (nombre/teléfono del cliente).
 */
export async function listPendingReminders(
  companyId: string,
  opts?: { type?: ScheduledMessageType; q?: string; productId?: string },
): Promise<
  Array<{
    id: string;
    type: ScheduledMessageType;
    sendAt: Date;
    body: string;
    mediaUrl: string | null;
    customerId: string;
    conversationId: string | null;
    productId: string | null;
    customer: { name: string | null; phone: string };
  }>
> {
  const q = (opts?.q ?? "").trim();
  const productId = (opts?.productId ?? "").trim();
  const rows = await prisma.scheduledMessage.findMany({
    where: {
      companyId,
      status: ScheduledMessageStatus.PENDING,
      type: opts?.type ? opts.type : { in: FOLLOWUP_TYPES },
      // El productId se guarda en metadata al agendar el recordatorio (scheduleAutoReminders).
      ...(productId ? { metadata: { path: ["productId"], equals: productId } } : {}),
      ...(q
        ? {
            customer: {
              OR: [
                { name: { contains: q, mode: "insensitive" } },
                { phone: { contains: q.replace(/\D/g, "") || q } },
              ],
            },
          }
        : {}),
    },
    orderBy: { sendAt: "asc" },
    take: 500,
    select: {
      id: true,
      type: true,
      sendAt: true,
      body: true,
      mediaUrl: true,
      customerId: true,
      conversationId: true,
      metadata: true,
      customer: { select: { name: true, phone: true } },
    },
  });
  return rows.map(({ metadata, ...r }) => {
    const pid = metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).productId
      : null;
    return { ...r, productId: typeof pid === "string" ? pid : null };
  });
}

export function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}

export function secondsFromNow(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}
