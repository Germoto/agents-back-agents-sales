/**
 * Suscripciones / ventas con vencimiento (rubro STREAMER).
 * Gestiona las ventas del negocio (las del agente y las MANUALES/externas) y programa
 * el RECORDATORIO de vencimiento. NO entrega accesos: solo seguimiento + aviso (las
 * cuentas de streaming cambian de clave o se caen, no se pueden gestionar automático).
 */

import { Prisma, ScheduledMessageType, ScheduledMessageStatus, SubscriptionStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";

const DAY_MS = 86_400_000;

export interface RenewalReminderConfig {
  enabled?: boolean;
  daysBefore?: number;
  message?: string | null;
  mediaUrl?: string | null;
  mediaType?: string | null;
}

function normalizePhone(s: string): string {
  return "+" + String(s).replace(/\D/g, "");
}

function fmtDate(d: Date): string {
  // dd/mm/yyyy simple (sin tz: solo para el texto del recordatorio).
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

function substituteVars(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k: string) => vars[k.toLowerCase()] ?? `{${k}}`);
}

function defaultRenewalMessage(): string {
  return "Hola {nombre} 👋 tu plan de *{producto}* vence en {dias} día(s) ({vence}). ¿Quieres renovarlo para seguir sin cortes? 🍿";
}

async function upsertCustomerByPhone(companyId: string, phone: string, name?: string | null): Promise<string> {
  const normalized = normalizePhone(phone);
  const c = await prisma.customer.upsert({
    where: { companyId_phone: { companyId, phone: normalized } },
    update: { ...(name?.trim() ? { name: name.trim() } : {}), lastInteractionAt: new Date() },
    create: {
      companyId,
      phone: normalized,
      name: name?.trim() || null,
      status: "activo",
      lastInteractionAt: new Date(),
      metadata: { origin: "subscription-manual" },
    },
    select: { id: true },
  });
  return c.id;
}

/** Programa (o reprograma) el recordatorio RENEWAL de una suscripción. Devuelve el id del mensaje. */
async function scheduleRenewalReminder(opts: {
  companyId: string;
  customerId: string;
  conversationId?: string | null;
  subscriptionId: string;
  productId?: string | null;
  customerName: string;
  productName: string;
  expiresAt: Date;
  reminder: RenewalReminderConfig;
}): Promise<string | null> {
  const r = opts.reminder ?? {};
  if (r.enabled === false) return null;
  const daysBefore = Number.isFinite(Number(r.daysBefore)) && Number(r.daysBefore) > 0 ? Number(r.daysBefore) : 2;
  // Disparar daysBefore antes del vencimiento; si ya pasó esa fecha, mandarlo cuanto antes.
  let sendAt = new Date(opts.expiresAt.getTime() - daysBefore * DAY_MS);
  const now = new Date();
  if (sendAt.getTime() < now.getTime()) sendAt = new Date(now.getTime() + 60_000);
  const body = substituteVars((r.message?.trim() || defaultRenewalMessage()), {
    nombre: opts.customerName || "",
    producto: opts.productName || "tu plan",
    dias: String(daysBefore),
    vence: fmtDate(opts.expiresAt),
  });
  const msg = await prisma.scheduledMessage.create({
    data: {
      companyId: opts.companyId,
      customerId: opts.customerId,
      conversationId: opts.conversationId ?? null,
      type: ScheduledMessageType.RENEWAL,
      sendAt,
      body,
      mediaUrl: r.mediaUrl?.trim() || null,
      metadata: {
        kind: "renewal",
        subscriptionId: opts.subscriptionId,
        productId: opts.productId ?? null,
        ...(r.mediaType ? { mediaType: r.mediaType } : {}),
      } as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return msg.id;
}

/** Cancela el/los recordatorios RENEWAL PENDING de una suscripción. */
async function cancelRenewalReminder(companyId: string, subscriptionId: string): Promise<void> {
  // Todos los RENEWAL llevan metadata.subscriptionId, así que el path query es seguro aquí.
  await prisma.scheduledMessage.updateMany({
    where: {
      companyId,
      type: ScheduledMessageType.RENEWAL,
      status: ScheduledMessageStatus.PENDING,
      metadata: { path: ["subscriptionId"], equals: subscriptionId },
    },
    data: { status: ScheduledMessageStatus.CANCELLED },
  });
}

export interface CreateSubscriptionInput {
  customerPhone?: string;
  customerId?: string;
  customerName?: string | null;
  productId?: string | null;
  productName?: string | null;
  planLabel?: string | null;
  startAt?: Date | string | null;
  expiresAt?: Date | string | null;
  durationDays?: number | null;
  amount?: string | null;
  source?: "AGENT" | "MANUAL";
  note?: string | null;
  conversationId?: string | null;
  reminder?: RenewalReminderConfig;
}

export async function createSubscription(companyId: string, input: CreateSubscriptionInput) {
  // Resolver cliente.
  let customerId = input.customerId ?? null;
  let customerName = input.customerName ?? null;
  if (!customerId) {
    if (!input.customerPhone?.trim()) throw new AppError("Falta el teléfono del cliente", 400);
    customerId = await upsertCustomerByPhone(companyId, input.customerPhone, input.customerName);
  }
  if (!customerName) {
    const c = await prisma.customer.findFirst({ where: { id: customerId, companyId }, select: { name: true } });
    customerName = c?.name ?? null;
  }

  // Resolver producto/nombre.
  let productName = input.productName?.trim() || null;
  if (!productName && input.productId) {
    const p = await prisma.product.findFirst({ where: { id: input.productId, companyId }, select: { name: true } });
    productName = p?.name ?? null;
  }

  // Calcular vencimiento.
  const startAt = input.startAt ? new Date(input.startAt) : new Date();
  const duration = input.durationDays != null ? Number(input.durationDays) : null;
  let expiresAt: Date;
  if (input.expiresAt) expiresAt = new Date(input.expiresAt);
  else if (duration && duration > 0) expiresAt = new Date(startAt.getTime() + duration * DAY_MS);
  else throw new AppError("Falta el vencimiento o la duración en días", 400);

  const sub = await prisma.subscription.create({
    data: {
      companyId,
      customerId,
      productId: input.productId ?? null,
      productName,
      planLabel: input.planLabel?.trim() || null,
      startAt,
      expiresAt,
      durationDays: duration,
      amount: input.amount?.trim() || null,
      status: SubscriptionStatus.ACTIVE,
      source: input.source ?? "MANUAL",
      note: input.note?.trim() || null,
    },
  });

  const reminderId = await scheduleRenewalReminder({
    companyId,
    customerId,
    conversationId: input.conversationId ?? null,
    subscriptionId: sub.id,
    productId: input.productId ?? null,
    customerName: customerName ?? "",
    productName: productName ?? "tu plan",
    expiresAt,
    reminder: input.reminder ?? {},
  });
  if (reminderId) {
    await prisma.subscription.update({ where: { id: sub.id }, data: { reminderMessageId: reminderId } });
  }
  return prisma.subscription.findUniqueOrThrow({
    where: { id: sub.id },
    include: { customer: { select: { name: true, phone: true } } },
  });
}

export async function listSubscriptions(
  companyId: string,
  opts?: { status?: string; filter?: "due" | "expired" | "active"; productId?: string; q?: string; daysAhead?: number },
) {
  const where: Prisma.SubscriptionWhereInput = { companyId };
  if (opts?.status) where.status = opts.status as SubscriptionStatus;
  if (opts?.productId) where.productId = opts.productId;
  const now = new Date();
  if (opts?.filter === "due") {
    where.status = SubscriptionStatus.ACTIVE;
    where.expiresAt = { lte: new Date(now.getTime() + (opts.daysAhead ?? 7) * DAY_MS) };
  } else if (opts?.filter === "expired") {
    where.OR = [{ status: SubscriptionStatus.EXPIRED }, { status: SubscriptionStatus.ACTIVE, expiresAt: { lt: now } }];
  } else if (opts?.filter === "active") {
    where.status = SubscriptionStatus.ACTIVE;
  }
  const q = (opts?.q ?? "").trim();
  if (q) {
    where.customer = {
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { phone: { contains: q.replace(/\D/g, "") || q } },
      ],
    };
  }
  return prisma.subscription.findMany({
    where,
    orderBy: { expiresAt: "asc" },
    take: 500,
    include: { customer: { select: { name: true, phone: true } } },
  });
}

async function getOwned(companyId: string, id: string) {
  const sub = await prisma.subscription.findFirst({ where: { id, companyId } });
  if (!sub) throw new AppError("Suscripción no encontrada", 404);
  return sub;
}

/** Marca renovada: extiende el vencimiento (+ durationDays) y reprograma el aviso. */
export async function markRenewed(companyId: string, id: string, reminder?: RenewalReminderConfig) {
  const sub = await getOwned(companyId, id);
  const duration = sub.durationDays && sub.durationDays > 0 ? sub.durationDays : 30;
  const base = sub.expiresAt.getTime() > Date.now() ? sub.expiresAt : new Date();
  const newExpires = new Date(base.getTime() + duration * DAY_MS);
  await cancelRenewalReminder(companyId, id);
  await prisma.subscription.update({
    where: { id },
    data: { status: SubscriptionStatus.ACTIVE, startAt: new Date(), expiresAt: newExpires },
  });
  const cust = await prisma.customer.findUnique({ where: { id: sub.customerId }, select: { name: true } });
  const reminderId = await scheduleRenewalReminder({
    companyId,
    customerId: sub.customerId,
    subscriptionId: id,
    productId: sub.productId,
    customerName: cust?.name ?? "",
    productName: sub.productName ?? "tu plan",
    expiresAt: newExpires,
    reminder: reminder ?? {},
  });
  await prisma.subscription.update({ where: { id }, data: { reminderMessageId: reminderId } });
  return prisma.subscription.findUniqueOrThrow({ where: { id }, include: { customer: { select: { name: true, phone: true } } } });
}

export async function markCancelled(companyId: string, id: string) {
  await getOwned(companyId, id);
  await cancelRenewalReminder(companyId, id);
  return prisma.subscription.update({
    where: { id },
    data: { status: SubscriptionStatus.CANCELLED },
    include: { customer: { select: { name: true, phone: true } } },
  });
}

export async function deleteSubscription(companyId: string, id: string) {
  await getOwned(companyId, id);
  await cancelRenewalReminder(companyId, id);
  await prisma.subscription.delete({ where: { id } });
  return { ok: true };
}

/**
 * Crea la suscripción de una venta hecha POR EL AGENTE (streaming con duración).
 * Best-effort: no rompe la entrega si algo falla. Dedupe: no duplica si ya hay una
 * ACTIVE vigente del mismo cliente+producto.
 */
export async function createSubscriptionForSale(opts: {
  companyId: string;
  customerId: string;
  conversationId?: string | null;
  productId: string;
  productName: string;
  planLabel?: string | null;
  durationDays: number;
  amount?: string | null;
  reminder?: RenewalReminderConfig;
}): Promise<void> {
  try {
    if (!opts.durationDays || opts.durationDays <= 0) return;
    const existing = await prisma.subscription.findFirst({
      where: {
        companyId: opts.companyId,
        customerId: opts.customerId,
        productId: opts.productId,
        status: SubscriptionStatus.ACTIVE,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (existing) return; // ya hay una vigente; no duplicar
    await createSubscription(opts.companyId, {
      customerId: opts.customerId,
      productId: opts.productId,
      productName: opts.productName,
      planLabel: opts.planLabel ?? null,
      durationDays: opts.durationDays,
      amount: opts.amount ?? null,
      source: "AGENT",
      conversationId: opts.conversationId ?? null,
      reminder: opts.reminder ?? {},
    });
  } catch (err) {
    console.warn("[subscriptions] createSubscriptionForSale falló (se ignora):", err instanceof Error ? err.message : err);
  }
}
