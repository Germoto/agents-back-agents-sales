/**
 * CRUD de recordatorios/seguimientos programados (ScheduledMessage).
 * El worker (scheduler.worker.ts) los consume; el agente los crea/cancela.
 */

import { Prisma, ScheduledMessageType, ScheduledMessageStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
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
  opts: { includeManual?: boolean; reason?: string } = {},
): Promise<number> {
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
  const ids = rows.filter((r) => opts.includeManual || !isManual(r.metadata)).map((r) => r.id);
  if (!ids.length) return 0;
  await prisma.scheduledMessage.updateMany({
    where: { id: { in: ids } },
    data: { status: ScheduledMessageStatus.CANCELLED, ...(opts.reason ? { failureReason: opts.reason } : {}) },
  });
  return ids.length;
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

/**
 * Tipos que se MUESTRAN en Recordatorios → Programados. Incluye citas y
 * renovaciones (que NO son follow-ups: las cancelaciones automáticas de
 * seguimiento usan FOLLOWUP_TYPES y no deben tocarlos).
 */
export const LISTABLE_TYPES: ScheduledMessageType[] = [
  ...FOLLOWUP_TYPES,
  ScheduledMessageType.BOOKING_REMINDER,
  ScheduledMessageType.RENEWAL,
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
export async function cancelRemindersByIds(companyId: string, ids: string[], reason?: string): Promise<number> {
  const clean = [...new Set(ids.map((s) => String(s).trim()).filter(Boolean))];
  if (!clean.length) return 0;
  const res = await prisma.scheduledMessage.updateMany({
    // Solo tipos visibles en Programados: los internos (FLOW_TIMEOUT, PAYMENT_RECHECK) no se tocan por id.
    where: { id: { in: clean }, companyId, status: ScheduledMessageStatus.PENDING, type: { in: LISTABLE_TYPES } },
    data: { status: ScheduledMessageStatus.CANCELLED, ...(reason ? { failureReason: reason } : {}) },
  });
  return res.count;
}

/** Filtros de la lista de pendientes (panel y copiloto). */
export type PendingReminderFilter = {
  type?: ScheduledMessageType;
  /** Varios tipos; si no hay type ni types se listan todos los LISTABLE_TYPES. */
  types?: ScheduledMessageType[];
  q?: string;
  productId?: string;
  customerId?: string;
  /** Solo los que llevan más de 1 h de atraso (misma condición que el contador `atrasados`). */
  lateOnly?: boolean;
};

/**
 * Condición "atrasado": hora PLANIFICADA (metadata.dueAt) hace más de 1 h o, en filas
 * viejas sin dueAt, sendAt hace más de 1 h. El tope por hora corre sendAt hacia adelante,
 * por eso no basta con sendAt. dueAt es ISO ⇒ la comparación de texto equivale a la de fecha.
 */
export function overdueRemindersWhere(now = new Date()): Prisma.ScheduledMessageWhereInput {
  const hourAgo = new Date(now.getTime() - 60 * 60_000);
  return {
    OR: [
      { metadata: { path: ["dueAt"], lt: hourAgo.toISOString() } },
      { sendAt: { lt: hourAgo } },
    ],
  };
}

/** where de los recordatorios PENDING visibles en Programados (nunca los internos). */
export function pendingRemindersWhere(companyId: string, opts: PendingReminderFilter = {}): Prisma.ScheduledMessageWhereInput {
  const q = (opts.q ?? "").trim();
  const productId = (opts.productId ?? "").trim();
  const types = opts.type ? [opts.type] : opts.types?.length ? opts.types : LISTABLE_TYPES;
  return {
    companyId,
    status: ScheduledMessageStatus.PENDING,
    type: { in: types.filter((t) => LISTABLE_TYPES.includes(t)) },
    ...(opts.customerId ? { customerId: opts.customerId } : {}),
    ...(opts.lateOnly ? overdueRemindersWhere() : {}),
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
  };
}

/** Hora PLANIFICADA del paso (metadata.dueAt); sendAt se corre con el ritmo/tope. */
export function reminderDueAt(row: { sendAt: Date; metadata: Prisma.JsonValue | null }): Date {
  const m = row.metadata;
  const raw = m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>).dueAt : null;
  const t = typeof raw === "string" ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? new Date(t) : row.sendAt;
}

/**
 * Cancela en lote por FILTRO (copiloto/MCP). Sin tipo explícito solo toca
 * seguimientos (FOLLOWUP_TYPES): citas y renovaciones se cancelan solo si se
 * nombran. `lateMoreThanHours` usa la hora planificada (dueAt), no sendAt.
 * Con dryRun solo cuenta y devuelve una muestra.
 */
export async function cancelRemindersByFilter(
  companyId: string,
  filter: Omit<PendingReminderFilter, "types"> & { lateMoreThanHours?: number },
  opts: { reason?: string; dryRun?: boolean } = {},
): Promise<{
  count: number;
  muestra: Array<{ id: string; type: ScheduledMessageType; dueAt: Date; customer: { name: string | null; phone: string } }>;
}> {
  const where = pendingRemindersWhere(companyId, { ...filter, types: filter.type ? undefined : FOLLOWUP_TYPES });
  const rows = await prisma.scheduledMessage.findMany({
    where,
    orderBy: { sendAt: "asc" },
    select: { id: true, type: true, sendAt: true, metadata: true, customer: { select: { name: true, phone: true } } },
  });
  const late = Number(filter.lateMoreThanHours);
  const cutoff = Number.isFinite(late) && late > 0 ? Date.now() - late * 3600_000 : null;
  const hits = cutoff == null ? rows : rows.filter((r) => reminderDueAt(r).getTime() < cutoff);
  const muestra = hits.slice(0, 5).map((r) => ({ id: r.id, type: r.type, dueAt: reminderDueAt(r), customer: r.customer }));
  if (opts.dryRun || !hits.length) return { count: hits.length, muestra };
  const count = await cancelRemindersByIds(companyId, hits.map((r) => r.id), opts.reason);
  return { count, muestra };
}

/**
 * Lista los recordatorios de seguimiento PENDING de una empresa (panel "Programados").
 * Excluye los internos (FLOW_TIMEOUT, PAYMENT_RECHECK). Filtro opcional por tipo y por
 * texto (nombre/teléfono del cliente).
 */
export type PendingReminderRow = {
  id: string;
  type: ScheduledMessageType;
  sendAt: Date;
  body: string;
  mediaUrl: string | null;
  customerId: string;
  conversationId: string | null;
  productId: string | null;
  /** Hora planificada del paso (metadata.dueAt; si no hay, sendAt). */
  dueAt: Date;
  /** Paso de la secuencia (0 = primero) y total de pasos, si aplica. */
  stepIndex: number | null;
  stepCount: number | null;
  /** Tipo del adjunto (metadata.mediaType: image|video|audio|pdf|document), si hay mediaUrl. */
  mediaType: string | null;
  customer: { name: string | null; phone: string };
};

export type PendingRemindersPage = {
  /** Página (por sendAt); por defecto hasta 500 filas. */
  items: PendingReminderRow[];
  /** Total REAL de pendientes que cumplen el filtro. */
  total: number;
  offset: number;
  limit: number;
  porTipo: Partial<Record<ScheduledMessageType, number>>;
  /** Pendientes con más de 1 h de atraso respecto a su hora planificada (dueAt). */
  atrasados: number;
};

export async function listPendingReminders(
  companyId: string,
  opts?: PendingReminderFilter & { offset?: number; limit?: number },
): Promise<PendingRemindersPage> {
  const where = pendingRemindersWhere(companyId, opts);
  const offset = Math.max(0, Math.floor(opts?.offset ?? 0));
  const limit = Math.min(Math.max(Math.floor(opts?.limit ?? 500), 1), 500);
  const [rows, total, byType, atrasados] = await Promise.all([
    prisma.scheduledMessage.findMany({
      where,
      orderBy: { sendAt: "asc" },
      skip: offset,
      take: limit,
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
    }),
    prisma.scheduledMessage.count({ where }),
    prisma.scheduledMessage.groupBy({ by: ["type"], where, _count: { _all: true } }),
    prisma.scheduledMessage.count({ where: { AND: [where, overdueRemindersWhere()] } }),
  ]);
  const porTipo: Partial<Record<ScheduledMessageType, number>> = {};
  for (const g of byType) porTipo[g.type] = g._count._all;
  const items = rows.map(({ metadata, ...r }) => {
    const m = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {};
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
      ...r,
      productId: typeof m.productId === "string" ? m.productId : null,
      dueAt: reminderDueAt({ sendAt: r.sendAt, metadata }),
      stepIndex: num(m.stepIndex),
      stepCount: num(m.stepCount),
      mediaType: r.mediaUrl && typeof m.mediaType === "string" ? m.mediaType : null,
    };
  });
  return { items, total, offset, limit, porTipo, atrasados };
}

/** Campos editables de un recordatorio pendiente (panel y copiloto). */
export type ScheduledReminderPatch = {
  body?: string;
  /** null quita la multimedia. */
  mediaUrl?: string | null;
  mediaType?: string | null;
  sendAt?: Date;
};

/**
 * Edita el contenido (texto y/o multimedia) y opcionalmente la hora de un recordatorio
 * PENDIENTE. Cambiar la hora también mueve metadata.dueAt (hora planificada). Nota: si el
 * cliente vuelve a escribir, el bot recrea la secuencia (carrito/visto) y el cambio se pierde.
 */
export async function updateScheduledReminder(
  companyId: string,
  id: string,
  patch: ScheduledReminderPatch,
): Promise<PendingReminderRow> {
  const row = await prisma.scheduledMessage.findFirst({
    where: { id, companyId, status: ScheduledMessageStatus.PENDING, type: { in: LISTABLE_TYPES } },
    select: { id: true, body: true, mediaUrl: true, sendAt: true, metadata: true },
  });
  if (!row) throw new AppError("El recordatorio no existe o ya no está pendiente", 404);
  const meta: Record<string, unknown> =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? { ...(row.metadata as Record<string, unknown>) } : {};
  const data: Prisma.ScheduledMessageUpdateInput = {};

  if (patch.body !== undefined) data.body = patch.body.trim();
  if (patch.mediaUrl !== undefined) {
    const url = (patch.mediaUrl ?? "").trim();
    if (url && !/^https?:\/\//i.test(url)) throw new AppError("La multimedia debe ser una URL http(s)", 400);
    data.mediaUrl = url || null;
    if (url) meta.mediaType = (patch.mediaType ?? "").trim() || guessMediaType(url);
    else delete meta.mediaType;
  } else if (patch.mediaType !== undefined && row.mediaUrl) {
    meta.mediaType = (patch.mediaType ?? "").trim() || guessMediaType(row.mediaUrl);
  }
  const finalBody = (data.body as string | undefined) ?? row.body;
  const finalMedia = patch.mediaUrl !== undefined ? (data.mediaUrl as string | null) : row.mediaUrl;
  if (!finalBody.trim() && !finalMedia) throw new AppError("El recordatorio necesita un mensaje o una multimedia", 400);
  if (patch.sendAt !== undefined) {
    if (!(patch.sendAt instanceof Date) || isNaN(patch.sendAt.getTime()) || patch.sendAt.getTime() <= Date.now()) {
      throw new AppError("La fecha del recordatorio debe ser futura", 400);
    }
    data.sendAt = patch.sendAt;
    meta.dueAt = patch.sendAt.toISOString();
  }
  meta.editedAt = new Date().toISOString();
  data.metadata = meta as Prisma.InputJsonObject;

  const updated = await prisma.scheduledMessage.update({
    where: { id: row.id },
    data,
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
  const m = updated.metadata as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const { metadata, ...rest } = updated;
  return {
    ...rest,
    productId: typeof m.productId === "string" ? m.productId : null,
    dueAt: reminderDueAt({ sendAt: updated.sendAt, metadata }),
    stepIndex: num(m.stepIndex),
    stepCount: num(m.stepCount),
    mediaType: updated.mediaUrl && typeof m.mediaType === "string" ? m.mediaType : null,
  };
}

/** Tipo de adjunto por extensión (image|video|audio|pdf|document), como lo espera el worker. */
export function guessMediaType(url: string): string {
  const ext = (url.split("?")[0].split("#")[0].match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return "image";
  if (["mp4", "mov", "webm", "3gp", "m4v"].includes(ext)) return "video";
  if (["mp3", "ogg", "m4a", "aac", "wav", "opus"].includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  return "document";
}

/**
 * Historial de recordatorios (cualquier estado) para ANÁLISIS: cómo salieron los
 * de una franja (p. ej. la apertura de las 7am), cancelados y fallidos con motivo.
 * Ordena por el instante relevante (sentAt para enviados, sendAt para el resto).
 */
export async function listReminderHistory(
  companyId: string,
  opts: { status?: ScheduledMessageStatus; from?: Date; to?: Date; limit?: number },
): Promise<
  Array<{
    id: string;
    type: ScheduledMessageType;
    status: ScheduledMessageStatus;
    sendAt: Date;
    sentAt: Date | null;
    failureReason: string | null;
    body: string;
    customer: { name: string | null; phone: string };
  }>
> {
  const status = opts.status ?? ScheduledMessageStatus.SENT;
  const timeField = status === ScheduledMessageStatus.SENT ? "sentAt" : "sendAt";
  const range = opts.from || opts.to ? { gte: opts.from, lte: opts.to } : undefined;
  return prisma.scheduledMessage.findMany({
    where: {
      companyId,
      status,
      type: { in: LISTABLE_TYPES },
      ...(range ? { [timeField]: range } : {}),
    },
    orderBy: { [timeField]: "desc" },
    take: Math.min(Math.max(opts.limit ?? 200, 1), 500),
    select: {
      id: true,
      type: true,
      status: true,
      sendAt: true,
      sentAt: true,
      failureReason: true,
      body: true,
      customer: { select: { name: true, phone: true } },
    },
  });
}

export function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}

export function secondsFromNow(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}
