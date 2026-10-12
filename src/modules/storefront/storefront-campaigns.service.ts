/**
 * Campañas de correo de la tienda (promociones): audiencia (filtros + contactos a mano +
 * correos pegados + filas CSV con campos propios), renderizado por destinatario y envío
 * por el worker (filas StoreEmail kind CAMPAIGN). Consentimiento: solo contactos con
 * emailMarketing=true y nunca con emailOptOut; los correos que el dueño pega/importa
 * se consideran consentidos (los crea/actualiza con emailMarketing=true).
 */

import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { AppError } from "../../lib/app-error";
import { mailerEnabled, sendMail } from "../../lib/mailer";
import { normalizeEmail } from "../../lib/email";
import { storeUrl } from "./storefront-url";
import { fillVars, renderStoreEmail, unsubUrlFor, type EmailVars } from "./storefront-email.service";

export type CampaignAudience = {
  /** all | buyers | subscribers | whatsapp | manual (solo contactos a mano/pegados/CSV) */
  source: "all" | "buyers" | "subscribers" | "whatsapp" | "manual";
  productId?: string | null;
  tagId?: string | null;
  customerIds?: string[];
  emails?: string[];
  rows?: { email: string; nombre?: string | null; campo1?: string | null; campo2?: string | null; campo3?: string | null; cupon?: string | null }[];
};

export type Recipient = {
  customerId: string | null;
  email: string;
  name: string | null;
  lastProduct: string | null;
  productsBought: string[];
  daysSincePurchase: number | null;
  fields: Record<string, string>;
  couponCode: string | null;
};

const CAMPAIGN_SELECT = {
  id: true, name: true, subject: true, body: true, imageUrl: true, ctaLabel: true, ctaUrl: true, couponCode: true, audience: true, status: true,
  scheduledAt: true, totalCount: true, sentCount: true, failedCount: true, startedAt: true, completedAt: true, createdAt: true, updatedAt: true,
} satisfies Prisma.StoreEmailCampaignSelect;

function audienceOf(raw: unknown): CampaignAudience {
  const a = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Partial<CampaignAudience>;
  const src = ["all", "buyers", "subscribers", "whatsapp", "manual"].includes(String(a.source)) ? (a.source as CampaignAudience["source"]) : "buyers";
  return {
    source: src,
    productId: a.productId ?? null,
    tagId: a.tagId ?? null,
    customerIds: Array.isArray(a.customerIds) ? a.customerIds.filter((x): x is string => typeof x === "string").slice(0, 5000) : [],
    emails: Array.isArray(a.emails) ? a.emails.map((e) => normalizeEmail(e)).filter((e): e is string => Boolean(e)).slice(0, 5000) : [],
    rows: Array.isArray(a.rows)
      ? a.rows
          .map((r) => ({ ...r, email: normalizeEmail((r as { email?: string }).email) ?? "" }))
          .filter((r) => r.email)
          .slice(0, 5000)
      : [],
  };
}

function syntheticPhone(email: string): string {
  return `web:${crypto.createHash("sha256").update(email).digest("hex").slice(0, 12)}`;
}

function md(c: { metadata: Prisma.JsonValue | null }): Record<string, unknown> {
  return (c.metadata && typeof c.metadata === "object" && !Array.isArray(c.metadata) ? c.metadata : {}) as Record<string, unknown>;
}

/** Datos de compra por cliente (último producto, lista, días desde la última compra). */
async function purchaseInfo(companyId: string, customerIds: string[]) {
  if (!customerIds.length) return new Map<string, { last: string | null; names: string[]; days: number | null }>();
  const orders = await prisma.storeOrder.findMany({
    where: { companyId, status: "ENTREGADO", customerId: { in: customerIds } },
    select: { customerId: true, productName: true, items: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  const map = new Map<string, { last: string | null; names: string[]; days: number | null }>();
  for (const o of orders) {
    const names = Array.isArray(o.items) && (o.items as unknown[]).length ? (o.items as { name: string }[]).map((i) => i.name) : [o.productName];
    const cur = map.get(o.customerId) ?? { last: null, names: [], days: null };
    if (!cur.last) {
      cur.last = names[0] ?? null;
      cur.days = Math.floor((Date.now() - o.createdAt.getTime()) / 86_400_000);
    }
    for (const n of names) if (!cur.names.includes(n)) cur.names.push(n);
    map.set(o.customerId, cur);
  }
  return map;
}

/** Resuelve la audiencia a destinatarios únicos (por correo), aplicando consentimiento y bajas. */
export async function resolveAudience(companyId: string, rawAudience: unknown): Promise<Recipient[]> {
  const a = audienceOf(rawAudience);
  const byEmail = new Map<string, Recipient>();
  const add = (r: Recipient) => {
    if (!byEmail.has(r.email)) byEmail.set(r.email, r);
    else {
      const cur = byEmail.get(r.email)!;
      cur.fields = { ...cur.fields, ...r.fields };
      if (r.couponCode) cur.couponCode = r.couponCode;
    }
  };

  // 1) Filtro base (todos / compradores / suscriptores / WhatsApp)
  if (a.source !== "manual") {
    let where: Prisma.CustomerWhereInput = { companyId, email: { not: null } };
    if (a.source === "subscribers") where = { ...where, metadata: { path: ["origin"], equals: "newsletter" } };
    if (a.source === "whatsapp") where = { ...where, NOT: { phone: { startsWith: "web:" } } };
    if (a.tagId) where = { ...where, tagLinks: { some: { tagId: a.tagId } } };
    if (a.source === "buyers") {
      const buyers = await prisma.storeOrder.findMany({
        where: { companyId, status: "ENTREGADO", ...(a.productId ? { OR: [{ productId: a.productId }, { productIds: { has: a.productId } }] } : {}) },
        select: { customerId: true },
        distinct: ["customerId"],
      });
      where = { ...where, id: { in: buyers.map((b) => b.customerId) } };
    }
    const customers = await prisma.customer.findMany({ where, select: { id: true, name: true, email: true, metadata: true }, take: 20000 });
    for (const c of customers) {
      const m = md(c);
      if (m.emailOptOut === true || m.emailMarketing === false) continue;
      const email = normalizeEmail(c.email);
      if (!email) continue;
      add({ customerId: c.id, email, name: c.name, lastProduct: null, productsBought: [], daysSincePurchase: null, fields: {}, couponCode: null });
    }
  }

  // 2) Contactos elegidos a mano
  if (a.customerIds?.length) {
    const customers = await prisma.customer.findMany({ where: { companyId, id: { in: a.customerIds }, email: { not: null } }, select: { id: true, name: true, email: true, metadata: true } });
    for (const c of customers) {
      if (md(c).emailOptOut === true) continue;
      const email = normalizeEmail(c.email);
      if (email) add({ customerId: c.id, email, name: c.name, lastProduct: null, productsBought: [], daysSincePurchase: null, fields: {}, couponCode: null });
    }
  }

  // 3) Correos pegados y filas CSV: se crean/actualizan como contactos con consentimiento.
  const extra = [
    ...(a.emails ?? []).map((email) => ({ email, nombre: null as string | null, fields: {} as Record<string, string>, cupon: null as string | null })),
    ...(a.rows ?? []).map((r) => ({
      email: r.email,
      nombre: r.nombre ?? null,
      fields: Object.fromEntries((["campo1", "campo2", "campo3"] as const).map((k) => [k, String(r[k] ?? "").trim()]).filter(([, v]) => v)),
      cupon: (r.cupon ?? "").toString().trim().toUpperCase() || null,
    })),
  ];
  for (const e of extra) {
    const existing = await prisma.customer.findFirst({ where: { companyId, email: e.email }, select: { id: true, name: true, metadata: true } });
    let customerId: string;
    let name = e.nombre;
    if (existing) {
      if (md(existing).emailOptOut === true) continue;
      customerId = existing.id;
      name = existing.name ?? e.nombre;
      if (md(existing).emailMarketing !== true) {
        await prisma.customer.update({ where: { id: existing.id }, data: { metadata: { ...md(existing), emailMarketing: true } } }).catch(() => undefined);
      }
    } else {
      const c = await prisma.customer.upsert({
        where: { companyId_phone: { companyId, phone: syntheticPhone(e.email) } },
        update: { email: e.email, ...(e.nombre ? { name: e.nombre } : {}), metadata: { origin: "import", emailMarketing: true } },
        create: { companyId, phone: syntheticPhone(e.email), email: e.email, name: e.nombre, status: "activo", lastInteractionAt: new Date(), metadata: { origin: "import", emailMarketing: true } },
        select: { id: true },
      });
      customerId = c.id;
    }
    add({ customerId, email: e.email, name, lastProduct: null, productsBought: [], daysSincePurchase: null, fields: e.fields, couponCode: e.cupon });
  }

  // 4) Datos de compra para las variables
  const list = [...byEmail.values()];
  const info = await purchaseInfo(companyId, list.map((r) => r.customerId).filter((x): x is string => Boolean(x)));
  for (const r of list) {
    const i = r.customerId ? info.get(r.customerId) : undefined;
    if (i) {
      r.lastProduct = i.last;
      r.productsBought = i.names;
      r.daysSincePurchase = i.days;
    }
  }
  return list;
}

function withUtm(url: string, campaignId: string, coupon?: string | null): string {
  try {
    const u = new URL(url);
    u.searchParams.set("utm_source", "email");
    u.searchParams.set("utm_campaign", campaignId);
    if (coupon) u.searchParams.set("cupon", coupon);
    return u.toString();
  } catch {
    return url;
  }
}

async function context(companyId: string) {
  const [company, cfg] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { name: true, slug: true, currency: true } }),
    prisma.storefrontConfig.findUnique({ where: { companyId } }),
  ]);
  if (!company || !cfg) throw new AppError("Tienda no configurada", 404);
  return { company, cfg, storeName: cfg.title || company.name, accent: cfg.accentColor || "#5b34e0", base: storeUrl(company.slug) };
}

function firstName(name: string | null | undefined): string {
  const n = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return n ? n.charAt(0).toUpperCase() + n.slice(1) : "";
}

type CampaignRow = Prisma.StoreEmailCampaignGetPayload<{ select: typeof CAMPAIGN_SELECT }>;

function varsFor(c: { subject: string; body: string; ctaUrl: string | null; couponCode: string | null; id: string }, r: Recipient, storeName: string, base: string): { vars: EmailVars; ctaUrl: string; coupon: string | null } {
  const coupon = r.couponCode || c.couponCode || null;
  const ctaUrl = withUtm(c.ctaUrl || base, c.id, coupon);
  const vars: EmailVars = {
    nombre: firstName(r.name) || "Hola",
    correo: r.email,
    ultimo_producto: r.lastProduct ?? "",
    productos_comprados: r.productsBought.join(", "),
    dias_desde_compra: r.daysSincePurchase === null ? "" : String(r.daysSincePurchase),
    tienda: storeName,
    cupon: coupon ?? "",
    link: ctaUrl,
    campo1: r.fields.campo1 ?? "",
    campo2: r.fields.campo2 ?? "",
    campo3: r.fields.campo3 ?? "",
  };
  return { vars, ctaUrl, coupon };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listCampaigns(companyId: string) {
  const rows = await prisma.storeEmailCampaign.findMany({ where: { companyId }, orderBy: { createdAt: "desc" }, select: CAMPAIGN_SELECT, take: 100 });
  return Promise.all(rows.map((r) => withMetrics(companyId, r)));
}

async function withMetrics(companyId: string, c: CampaignRow) {
  if (c.status === "DRAFT") return { ...c, metricas: { clics: 0, compras: 0 } };
  const [clics, compras] = await Promise.all([
    prisma.storeEvent.count({ where: { companyId, type: "EMAIL_CLICK", campaignId: c.id } }),
    c.startedAt
      ? prisma.storeOrder.count({
          where: { companyId, status: "ENTREGADO", createdAt: { gte: c.startedAt, lte: new Date(c.startedAt.getTime() + 72 * 3_600_000) }, metadata: { path: ["web", "url"], string_contains: c.id } },
        })
      : 0,
  ]);
  return { ...c, metricas: { clics, compras } };
}

export async function getCampaign(companyId: string, id: string) {
  const c = await prisma.storeEmailCampaign.findFirst({ where: { id, companyId }, select: CAMPAIGN_SELECT });
  if (!c) throw new AppError("Campaña no encontrada", 404);
  return withMetrics(companyId, c);
}

export type CampaignInput = {
  name: string;
  subject: string;
  body: string;
  imageUrl?: string | null;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  couponCode?: string | null;
  audience?: unknown;
};

function cleanInput(data: Partial<CampaignInput>) {
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  if (data.imageUrl && !data.imageUrl.startsWith(`${base}/uploads/`)) throw new AppError("La imagen debe ser un archivo subido a FlowApp", 400);
  return {
    ...(data.name !== undefined ? { name: data.name.trim().slice(0, 120) } : {}),
    ...(data.subject !== undefined ? { subject: data.subject.trim().slice(0, 150) } : {}),
    ...(data.body !== undefined ? { body: data.body.trim().slice(0, 6000) } : {}),
    ...(data.imageUrl !== undefined ? { imageUrl: data.imageUrl || null } : {}),
    ...(data.ctaLabel !== undefined ? { ctaLabel: (data.ctaLabel ?? "").trim().slice(0, 40) || null } : {}),
    ...(data.ctaUrl !== undefined ? { ctaUrl: (data.ctaUrl ?? "").trim().slice(0, 500) || null } : {}),
    ...(data.couponCode !== undefined ? { couponCode: (data.couponCode ?? "").trim().toUpperCase().slice(0, 30) || null } : {}),
    ...(data.audience !== undefined ? { audience: audienceOf(data.audience) as unknown as Prisma.InputJsonValue } : {}),
  };
}

export async function createCampaign(companyId: string, data: CampaignInput) {
  if (!data.name?.trim() || !data.subject?.trim() || !data.body?.trim()) throw new AppError("Nombre, asunto y cuerpo son obligatorios", 400);
  const c = await prisma.storeEmailCampaign.create({ data: { companyId, ...cleanInput(data), name: data.name.trim().slice(0, 120), subject: data.subject.trim().slice(0, 150), body: data.body.trim().slice(0, 6000) }, select: CAMPAIGN_SELECT });
  return withMetrics(companyId, c);
}

export async function updateCampaign(companyId: string, id: string, data: Partial<CampaignInput>) {
  const c = await prisma.storeEmailCampaign.findFirst({ where: { id, companyId }, select: { status: true } });
  if (!c) throw new AppError("Campaña no encontrada", 404);
  if (c.status === "RUNNING" || c.status === "COMPLETED") throw new AppError("Una campaña enviada no se edita; duplícala", 409);
  // Una programada ya tiene sus correos resueltos en cola: al editarla se desprograma (vuelve a BORRADOR) y hay que volver a programarla.
  if (c.status === "SCHEDULED") await prisma.storeEmail.updateMany({ where: { campaignId: id, status: "PENDING" }, data: { status: "CANCELLED", failureReason: "Campaña editada" } });
  const unschedule = c.status === "SCHEDULED" ? { status: "DRAFT", scheduledAt: null, totalCount: 0 } : {};
  const u = await prisma.storeEmailCampaign.update({ where: { id }, data: { ...cleanInput(data), ...unschedule }, select: CAMPAIGN_SELECT });
  return withMetrics(companyId, u);
}

export async function deleteCampaign(companyId: string, id: string) {
  const c = await prisma.storeEmailCampaign.findFirst({ where: { id, companyId }, select: { status: true } });
  if (!c) throw new AppError("Campaña no encontrada", 404);
  if (c.status === "RUNNING") throw new AppError("Cancela la campaña antes de borrarla", 409);
  await prisma.storeEmail.updateMany({ where: { campaignId: id, status: "PENDING" }, data: { status: "CANCELLED", failureReason: "Campaña borrada" } });
  await prisma.storeEmailCampaign.delete({ where: { id } });
  return { ok: true };
}

export async function duplicateCampaign(companyId: string, id: string) {
  const c = await prisma.storeEmailCampaign.findFirst({ where: { id, companyId }, select: CAMPAIGN_SELECT });
  if (!c) throw new AppError("Campaña no encontrada", 404);
  const copy = await prisma.storeEmailCampaign.create({
    data: { companyId, name: `${c.name} (copia)`.slice(0, 120), subject: c.subject, body: c.body, imageUrl: c.imageUrl, ctaLabel: c.ctaLabel, ctaUrl: c.ctaUrl, couponCode: c.couponCode, audience: c.audience as Prisma.InputJsonValue },
    select: CAMPAIGN_SELECT,
  });
  return withMetrics(companyId, copy);
}

export async function previewAudience(companyId: string, audience: unknown) {
  const list = await resolveAudience(companyId, audience);
  return { total: list.length, muestra: list.slice(0, 8).map((r) => ({ email: r.email, nombre: r.name, ultimoProducto: r.lastProduct })) };
}

export async function sendCampaignTest(companyId: string, id: string, to: string) {
  const email = normalizeEmail(to);
  if (!email) throw new AppError("Correo de destino inválido", 400);
  if (!mailerEnabled()) throw new AppError("El envío de correos no está disponible en esta instalación", 409);
  const c = await prisma.storeEmailCampaign.findFirst({ where: { id, companyId }, select: CAMPAIGN_SELECT });
  if (!c) throw new AppError("Campaña no encontrada", 404);
  const ctx = await context(companyId);
  const sample: Recipient = { customerId: null, email, name: "Ana", lastProduct: "Pack de ejemplo", productsBought: ["Pack de ejemplo"], daysSincePurchase: 5, fields: { campo1: "valor 1", campo2: "valor 2", campo3: "valor 3" }, couponCode: null };
  const { vars, ctaUrl, coupon } = varsFor(c, sample, ctx.storeName, ctx.base);
  const subject = `[Prueba] ${fillVars(c.subject, vars)}`;
  const body = fillVars(c.body, vars);
  const { html, text } = renderStoreEmail({ storeName: ctx.storeName, accent: ctx.accent, logoUrl: ctx.cfg.logoUrl, subject, body: withImage(body, c.imageUrl), ctaLabel: c.ctaLabel || "Ver la tienda", ctaUrl, couponCode: coupon, unsubUrl: null, storeLink: ctx.base });
  await sendMail({ to: email, subject, html, text, fromName: `${ctx.storeName} vía FlowApp` });
  return { ok: true };
}

/** La imagen opcional del banner va como primera línea del cuerpo (URL → el render la linkifica); el HTML la incrusta. */
function withImage(body: string, imageUrl: string | null): string {
  return imageUrl ? `${imageUrl}\n\n${body}` : body;
}

/** Enviar ahora o programar: resuelve la audiencia y crea las filas StoreEmail. */
export async function startCampaign(companyId: string, id: string, input: { scheduledAt?: string | null }) {
  if (!mailerEnabled()) throw new AppError("El envío de correos no está disponible en esta instalación", 409);
  const c = await prisma.storeEmailCampaign.findFirst({ where: { id, companyId }, select: CAMPAIGN_SELECT });
  if (!c) throw new AppError("Campaña no encontrada", 404);
  if (c.status === "RUNNING" || c.status === "COMPLETED") throw new AppError("La campaña ya se envió", 409);
  const ctx = await context(companyId);
  const recipients = await resolveAudience(companyId, c.audience);
  if (!recipients.length) throw new AppError("La audiencia está vacía (recuerda: solo contactos con correo y consentimiento)", 400);
  const sendAt = input.scheduledAt ? new Date(input.scheduledAt) : new Date();
  if (Number.isNaN(sendAt.getTime())) throw new AppError("Fecha de programación inválida", 400);
  // Limpia envíos previos (reintento de un borrador cancelado).
  await prisma.storeEmail.updateMany({ where: { campaignId: id, status: "PENDING" }, data: { status: "CANCELLED", failureReason: "Reprogramada" } });
  const rows: Prisma.StoreEmailCreateManyInput[] = recipients.map((r) => {
    const { vars, ctaUrl, coupon } = varsFor(c, r, ctx.storeName, ctx.base);
    return {
      companyId,
      customerId: r.customerId,
      campaignId: id,
      kind: "CAMPAIGN",
      email: r.email,
      subject: fillVars(c.subject, vars),
      body: withImage(fillVars(c.body, vars), c.imageUrl),
      ctaLabel: c.ctaLabel || "Ver la tienda",
      ctaUrl,
      couponCode: coupon,
      sendAt,
    };
  });
  for (let i = 0; i < rows.length; i += 500) await prisma.storeEmail.createMany({ data: rows.slice(i, i + 500) });
  const scheduled = sendAt.getTime() > Date.now() + 60_000;
  const u = await prisma.storeEmailCampaign.update({
    where: { id },
    data: { status: scheduled ? "SCHEDULED" : "RUNNING", scheduledAt: sendAt, totalCount: rows.length, sentCount: 0, failedCount: 0, startedAt: scheduled ? null : new Date(), completedAt: null },
    select: CAMPAIGN_SELECT,
  });
  return withMetrics(companyId, u);
}

export async function cancelCampaign(companyId: string, id: string) {
  const c = await prisma.storeEmailCampaign.findFirst({ where: { id, companyId }, select: { status: true } });
  if (!c) throw new AppError("Campaña no encontrada", 404);
  await prisma.storeEmail.updateMany({ where: { campaignId: id, status: "PENDING" }, data: { status: "CANCELLED", failureReason: "Campaña cancelada" } });
  const u = await prisma.storeEmailCampaign.update({ where: { id }, data: { status: "CANCELLED", completedAt: new Date() }, select: CAMPAIGN_SELECT });
  return withMetrics(companyId, u);
}

/** Worker: arranca las programadas vencidas y actualiza contadores/estado de las que corren. */
export async function reconcileCampaigns(): Promise<void> {
  await prisma.storeEmailCampaign.updateMany({ where: { status: "SCHEDULED", scheduledAt: { lte: new Date() } }, data: { status: "RUNNING", startedAt: new Date() } });
  const running = await prisma.storeEmailCampaign.findMany({ where: { status: "RUNNING" }, select: { id: true } });
  for (const c of running) {
    const [sent, failed, pending] = await Promise.all([
      prisma.storeEmail.count({ where: { campaignId: c.id, status: "SENT" } }),
      prisma.storeEmail.count({ where: { campaignId: c.id, status: "FAILED" } }),
      prisma.storeEmail.count({ where: { campaignId: c.id, status: { in: ["PENDING", "SENDING"] } } }),
    ]);
    await prisma.storeEmailCampaign.update({ where: { id: c.id }, data: { sentCount: sent, failedCount: failed, ...(pending === 0 ? { status: "COMPLETED", completedAt: new Date() } : {}) } });
  }
}

/** Buscador de contactos con correo para elegir a mano. */
export async function searchEmailContacts(companyId: string, q: string, limit = 30) {
  const term = q.trim();
  const customers = await prisma.customer.findMany({
    where: {
      companyId,
      email: { not: null },
      ...(term ? { OR: [{ name: { contains: term, mode: "insensitive" } }, { email: { contains: term, mode: "insensitive" } }, { phone: { contains: term } }] } : {}),
    },
    select: { id: true, name: true, email: true, phone: true, metadata: true },
    orderBy: { lastInteractionAt: "desc" },
    take: limit,
  });
  const info = await purchaseInfo(companyId, customers.map((c) => c.id));
  return customers.map((c) => {
    const m = md(c);
    return {
      id: c.id,
      name: c.name,
      email: c.email,
      origen: m.origin === "newsletter" ? "suscriptor" : m.origin === "import" ? "importado" : c.phone.startsWith("web:") ? "tienda" : "whatsapp",
      optOut: m.emailOptOut === true,
      marketing: m.emailMarketing !== false,
      ultimoProducto: info.get(c.id)?.last ?? null,
    };
  });
}

export async function listEmailTags(companyId: string) {
  return prisma.customerTag.findMany({ where: { companyId }, select: { id: true, name: true, color: true }, orderBy: { name: "asc" } });
}
