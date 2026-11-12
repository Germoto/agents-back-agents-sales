/**
 * Correos de la tienda web: recordatorios automáticos (checkout abandonado, post-compra),
 * bienvenida de suscriptores y, más adelante, campañas. Se encolan en StoreEmail y el
 * worker de la tienda los envía cuando vence `sendAt` con el SMTP de la plataforma
 * (`sendMail`, remitente "<Tienda> vía FlowApp").
 *
 * Reglas: nunca a quien se dio de baja (Customer.metadata.emailOptOut); tope diario por
 * negocio (STORE_EMAIL_DAILY_CAP) y ritmo por minuto (STORE_EMAIL_PER_MINUTE); los
 * recordatorios de un pedido se cancelan solos cuando el pedido se paga o falla.
 *
 * Tienda de productos físicos: los textos por defecto son otros (no hablan de accesos),
 * el post-compra se programa cuando el pedido real llega a ENTREGADO y el comprador que
 * dejó correo recibe además un correo de «pedido recibido» con el enlace de seguimiento.
 */

import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { AppError } from "../../lib/app-error";
import { sendMail, mailerEnabled } from "../../lib/mailer";
import { normalizeEmail } from "../../lib/email";
import { signEmailUnsubToken, verifyEmailUnsubToken } from "../../lib/jwt";
import { applySpintax } from "../agent/reminder-templates";
import { plainTextToHtml } from "../agent/delivery.emails";
import { symbolFor } from "../../lib/currency";
import { storeUrl } from "./storefront-url";
import { storeKindOf, type StoreKind } from "./storefront-physical";

// ---------------------------------------------------------------------------
// Configuración (StorefrontConfig.emailReminders) y defaults
// ---------------------------------------------------------------------------

/** couponByProduct: cupón distinto según el producto principal del pedido (vacío = couponCode). */
export type EmailStep = { delayMinutes: number; subject: string; body: string; couponCode?: string | null; couponByProduct?: Record<string, string> | null };
export type EmailReminders = {
  abandonedCheckout: { enabled: boolean; steps: EmailStep[] };
  postPurchase: { enabled: boolean; delayDays: number; subject: string; body: string; couponCode?: string | null; couponByProduct?: Record<string, string> | null };
  welcome: { enabled: boolean; subject: string; body: string; couponCode?: string | null };
};

export const DEFAULT_EMAIL_REMINDERS: EmailReminders = {
  abandonedCheckout: {
    enabled: true,
    steps: [
      {
        delayMinutes: 60,
        subject: "{nombre}, tu {producto} te está esperando",
        body:
          "{Hola|Qué tal} {nombre} 👋\n\nVimos que empezaste tu compra de {producto} ({precio}) y quedó a medias. Tu pedido sigue guardado: puedes terminarlo en un minuto desde el botón de abajo.\n\nSi tuviste algún problema con el pago, escríbenos y te ayudamos.",
      },
      {
        delayMinutes: 1440,
        subject: "¿Lo dejamos listo? {producto} por {precio}",
        body:
          "{Hola|Buenas} {nombre},\n\n{Seguimos|Aún estamos} guardando tu pedido de {producto}. Recibes el acceso en tu correo apenas se confirma el pago, sin esperas.\n\n¿Alguna duda antes de decidir? Respóndenos y te ayudamos.",
      },
      {
        delayMinutes: 4320,
        subject: "Última oportunidad para {producto}",
        body:
          "{nombre}, este es el último recordatorio de tu pedido de {producto}.\n\nUsa el cupón {cupon} y llévatelo hoy con descuento. Después de este correo no te volveremos a escribir por este pedido 🙂",
      },
    ],
  },
  postPurchase: {
    enabled: true,
    delayDays: 3,
    subject: "¿Cómo te fue con {producto}?",
    body:
      "{Hola|Qué tal} {nombre} 👋\n\nEsperamos que estés disfrutando {producto}. Si tienes cualquier duda, respóndenos y te ayudamos.\n\nY si quieres seguir, te dejamos {relacionado} con el cupón {cupon}.",
  },
  welcome: {
    enabled: true,
    subject: "¡Bienvenido a {tienda}!",
    body: "{Hola|Qué tal} {nombre} 👋\n\nGracias por suscribirte. Te avisaremos de las nuevas ofertas y lanzamientos de {tienda}.\n\nPara empezar, aquí tienes el cupón {cupon} 🎁",
  },
};

/** Defaults de una tienda de productos físicos: hablan de pedido y entrega, no de accesos. */
export const DEFAULT_EMAIL_REMINDERS_PHYSICAL: EmailReminders = {
  abandonedCheckout: {
    enabled: true,
    steps: [
      {
        delayMinutes: 60,
        subject: "{nombre}, tu pedido de {producto} quedó a medias",
        body:
          "{Hola|Qué tal} {nombre} 👋\n\nVimos que empezaste tu pedido de {producto} ({precio}) y quedó a medias. Puedes terminarlo en un minuto desde el botón de abajo.\n\nSi tuviste algún problema con el pago o con el envío, escríbenos y te ayudamos.",
      },
      {
        delayMinutes: 1440,
        subject: "¿Te ayudamos a terminar tu pedido?",
        body:
          "{Hola|Buenas} {nombre},\n\n{Seguimos|Aún estamos} guardando tu pedido de {producto}. Apenas se confirma el pago lo preparamos para la entrega.\n\n¿Alguna duda sobre el envío o el producto? Respóndenos y te ayudamos.",
      },
      {
        delayMinutes: 4320,
        subject: "Último recordatorio de tu pedido",
        body:
          "{nombre}, este es el último recordatorio de tu pedido de {producto}.\n\nSi todavía lo quieres, puedes terminarlo desde el botón de abajo. Después de este correo no te volveremos a escribir por este pedido 🙂",
      },
    ],
  },
  postPurchase: {
    enabled: true,
    delayDays: 3,
    subject: "¿Cómo te fue con tu pedido?",
    body:
      "{Hola|Qué tal} {nombre} 👋\n\nEsperamos que tu pedido de {producto} haya llegado bien. Si tienes alguna duda o algo no llegó como esperabas, respóndenos y lo resolvemos.\n\nCuando quieras volver a comprar, la tienda está a un clic.",
  },
  welcome: DEFAULT_EMAIL_REMINDERS.welcome,
};

/** `kind` solo decide los textos por defecto de lo que el negocio todavía no personalizó. */
export function emailRemindersOf(raw: unknown, kind: StoreKind = "DIGITAL"): EmailReminders {
  const v = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Partial<EmailReminders>;
  const d = kind === "PHYSICAL" ? DEFAULT_EMAIL_REMINDERS_PHYSICAL : DEFAULT_EMAIL_REMINDERS;
  return {
    abandonedCheckout: {
      enabled: v.abandonedCheckout?.enabled ?? d.abandonedCheckout.enabled,
      steps: (v.abandonedCheckout?.steps?.length ? v.abandonedCheckout.steps : d.abandonedCheckout.steps).slice(0, 3),
    },
    postPurchase: { ...d.postPurchase, ...(v.postPurchase ?? {}) },
    welcome: { ...d.welcome, ...(v.welcome ?? {}) },
  };
}

/** Normaliza/recorta lo que manda el panel o el copiloto antes de guardarlo. */
export function sanitizeEmailReminders(input: unknown, kind: StoreKind = "DIGITAL"): EmailReminders {
  const r = emailRemindersOf(input, kind);
  const byProduct = (v: unknown): Record<string, string> | null => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const out: Record<string, string> = {};
    for (const [pid, code] of Object.entries(v as Record<string, unknown>)) {
      const c = String(code ?? "").trim().toUpperCase().slice(0, 30);
      if (pid && c) out[pid] = c;
    }
    return Object.keys(out).length ? out : null;
  };
  const step = (s: EmailStep): EmailStep => ({
    delayMinutes: Math.min(43200, Math.max(5, Math.round(Number(s.delayMinutes) || 60))),
    subject: String(s.subject ?? "").trim().slice(0, 120),
    body: String(s.body ?? "").trim().slice(0, 3000),
    couponCode: (s.couponCode ?? "").toString().trim().toUpperCase().slice(0, 30) || null,
    couponByProduct: byProduct(s.couponByProduct),
  });
  return {
    abandonedCheckout: { enabled: Boolean(r.abandonedCheckout.enabled), steps: r.abandonedCheckout.steps.map(step).filter((s) => s.subject && s.body).slice(0, 3) },
    postPurchase: {
      enabled: Boolean(r.postPurchase.enabled),
      delayDays: Math.min(60, Math.max(1, Math.round(Number(r.postPurchase.delayDays) || 3))),
      subject: String(r.postPurchase.subject ?? "").trim().slice(0, 120),
      body: String(r.postPurchase.body ?? "").trim().slice(0, 3000),
      couponCode: (r.postPurchase.couponCode ?? "").toString().trim().toUpperCase().slice(0, 30) || null,
      couponByProduct: byProduct(r.postPurchase.couponByProduct),
    },
    welcome: {
      enabled: Boolean(r.welcome.enabled),
      subject: String(r.welcome.subject ?? "").trim().slice(0, 120),
      body: String(r.welcome.body ?? "").trim().slice(0, 3000),
      couponCode: (r.welcome.couponCode ?? "").toString().trim().toUpperCase().slice(0, 30) || null,
    },
  };
}

// ---------------------------------------------------------------------------
// Variables y plantilla
// ---------------------------------------------------------------------------

export type EmailVars = Record<string, string>;

export function fillVars(text: string, vars: EmailVars): string {
  return applySpintax(text).replace(/\{([a-z_]+)\}/gi, (m, k: string) => (k in vars ? vars[k] : m)).replace(/[ \t]+\n/g, "\n").trim();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** HTML de marca de la tienda: cabecera con color/nombre, cuerpo, botón, cupón y pie con baja. */
export function renderStoreEmail(p: {
  storeName: string;
  accent: string;
  logoUrl?: string | null;
  subject: string;
  body: string;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  couponCode?: string | null;
  unsubUrl?: string | null;
  storeLink: string;
}): { html: string; text: string } {
  const accent = /^#[0-9a-fA-F]{6}$/.test(p.accent) ? p.accent : "#5b34e0";
  const cta = p.ctaUrl && p.ctaLabel
    ? `<p style="margin:24px 0 8px;text-align:center;"><a href="${escapeHtml(p.ctaUrl)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 28px;border-radius:12px;">${escapeHtml(p.ctaLabel)}</a></p>`
    : "";
  const coupon = p.couponCode
    ? `<p style="margin:16px 0 0;text-align:center;font-size:13px;color:#5b5668;">Tu cupón: <span style="display:inline-block;font-family:Consolas,Menlo,monospace;font-weight:700;font-size:15px;color:#17151f;background:#f3f1ec;border:1px dashed #cfcac1;padding:6px 12px;border-radius:8px;">${escapeHtml(p.couponCode)}</span></p>`
    : "";
  const logo = p.logoUrl
    ? `<img src="${escapeHtml(p.logoUrl)}" alt="" width="40" height="40" style="width:40px;height:40px;border-radius:10px;vertical-align:middle;margin-right:10px;">`
    : "";
  const unsub = p.unsubUrl ? ` · <a href="${escapeHtml(p.unsubUrl)}" style="color:#8a8597;">Darme de baja</a>` : "";
  // Banner: si la primera línea del cuerpo es una imagen subida a FlowApp (campañas), va como <img> y no como texto.
  const bannerMatch = /^(https?:\/\/\S+\.(?:png|jpe?g|gif|webp))\s*\n+/i.exec(p.body);
  const bodyText = bannerMatch ? p.body.slice(bannerMatch[0].length) : p.body;
  const banner = bannerMatch ? `<img src="${escapeHtml(bannerMatch[1])}" alt="" style="display:block;width:100%;height:auto;">` : "";
  const html = `
<div style="background:#f6f5f2;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;color:#17151f;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e7e4de;border-radius:18px;overflow:hidden;">
    <div style="background:${accent};color:#ffffff;padding:18px 24px;font-size:18px;font-weight:800;">${logo}<a href="${escapeHtml(p.storeLink)}" style="color:#ffffff;text-decoration:none;">${escapeHtml(p.storeName)}</a></div>
    ${banner}
    <div style="padding:26px 24px 22px;font-size:15px;line-height:1.6;color:#2c2936;">
      ${plainTextToHtml(bodyText)}
      ${cta}
      ${coupon}
    </div>
    <div style="padding:14px 24px;border-top:1px solid #efece6;font-size:12px;color:#8a8597;text-align:center;">
      Enviado por ${escapeHtml(p.storeName)} a través de FlowApp${unsub}
    </div>
  </div>
</div>`;
  const text = `${bodyText}\n\n${p.ctaUrl ? `${p.ctaLabel ?? "Ver"}: ${p.ctaUrl}\n` : ""}${p.couponCode ? `Cupón: ${p.couponCode}\n` : ""}\n— ${p.storeName} (vía FlowApp)${p.unsubUrl ? `\nDarme de baja: ${p.unsubUrl}` : ""}`;
  return { html, text };
}

function withUtm(url: string, campaign: string, extra?: Record<string, string>): string {
  const u = new URL(url);
  u.searchParams.set("utm_source", "email");
  u.searchParams.set("utm_campaign", campaign);
  for (const [k, v] of Object.entries(extra ?? {})) if (v) u.searchParams.set(k, v);
  return u.toString();
}

function firstName(name: string | null | undefined): string {
  const n = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return n ? n.charAt(0).toUpperCase() + n.slice(1) : "";
}

async function storeContext(companyId: string) {
  const [company, cfg] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { name: true, slug: true, currency: true, vertical: true } }),
    prisma.storefrontConfig.findUnique({ where: { companyId } }),
  ]);
  if (!company || !cfg) return null;
  const kind = storeKindOf(company.vertical, cfg.physical);
  return {
    company,
    cfg,
    kind,
    reminders: emailRemindersOf(cfg.emailReminders, kind),
    storeName: cfg.title || company.name,
    accent: cfg.accentColor || "#5b34e0",
    base: storeUrl(company.slug),
  };
}

async function customerOptedOut(customerId: string | null | undefined): Promise<boolean> {
  if (!customerId) return false;
  const c = await prisma.customer.findUnique({ where: { id: customerId }, select: { metadata: true } });
  return Boolean(((c?.metadata ?? {}) as { emailOptOut?: boolean }).emailOptOut);
}

async function couponIsUsable(companyId: string, code: string | null | undefined): Promise<string | null> {
  const c = (code ?? "").trim().toUpperCase();
  if (!c) return null;
  const row = await prisma.coupon.findUnique({ where: { companyId_code: { companyId, code: c } } });
  if (!row || !row.active) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
  if (row.maxUses !== null && row.uses >= row.maxUses) return null;
  return row.code;
}

// ---------------------------------------------------------------------------
// Programación de recordatorios
// ---------------------------------------------------------------------------

type OrderLike = {
  id: string;
  companyId: string;
  customerId: string;
  email: string | null;
  name: string;
  productId: string;
  productName: string;
  amount: Prisma.Decimal | number;
  currency: string;
  paymentMethod: string;
  accessToken: string;
  items?: unknown;
  /** Solo tienda física: total del pedido (`amount` es lo que toca pagar ahora). */
  orderTotal?: Prisma.Decimal | number | null;
  metadata?: unknown;
};

function isPhysicalOrder(order: OrderLike): boolean {
  return ((order.metadata ?? {}) as { kind?: unknown }).kind === "PHYSICAL";
}

/** Precio que se menciona en el correo: en físico el total del pedido, no el adelanto. */
function orderPriceText(order: OrderLike): string {
  const total = isPhysicalOrder(order) && order.orderTotal != null ? Number(order.orderTotal) : Number(order.amount);
  return `${symbolFor(order.currency)} ${total.toFixed(2)}`;
}

/** Carrito del pedido como `?items=id:cantidad,…` para que la tienda lo restaure. */
function cartLink(base: string, items: unknown): string {
  const lines = (Array.isArray(items) ? items : [])
    .map((raw) => {
      const l = (raw && typeof raw === "object" ? raw : {}) as { productId?: unknown; qty?: unknown };
      const qty = Math.max(1, Math.round(Number(l.qty) || 1));
      return typeof l.productId === "string" && l.productId ? `${l.productId}:${qty}` : "";
    })
    .filter(Boolean);
  return lines.length ? `${base}/carrito?items=${lines.join(",")}` : `${base}/carrito`;
}

/** Al crear un checkout: encola la secuencia de "checkout abandonado" (se cancela al pagar). */
export async function scheduleAbandonedCheckout(order: OrderLike): Promise<void> {
  try {
    // Sin correo (tienda física, donde es opcional) no hay a quién escribirle.
    const email = order.email;
    if (!email) return;
    const ctx = await storeContext(order.companyId);
    if (!ctx || !ctx.reminders.abandonedCheckout.enabled || !mailerEnabled()) return;
    if (await customerOptedOut(order.customerId)) return;
    // Un nuevo checkout reemplaza los recordatorios pendientes de otros pedidos del mismo correo.
    await prisma.storeEmail.updateMany({
      where: { companyId: order.companyId, email, kind: "ABANDONED_CHECKOUT", status: "PENDING", NOT: { orderId: order.id } },
      data: { status: "CANCELLED", failureReason: "Reemplazado por un nuevo checkout" },
    });
    const product = await prisma.product.findUnique({ where: { id: order.productId }, select: { slug: true } });
    const price = orderPriceText(order);
    // Yape/Plin: vuelve a su pedido para subir la captura. Mercado Pago: en digital a la
    // ficha del producto; en físico al carrito con sus productos y cantidades.
    const link = order.paymentMethod === "MANUAL"
      ? `${ctx.base}/gracias?o=${order.id}&t=${order.accessToken}`
      : isPhysicalOrder(order)
        ? cartLink(ctx.base, order.items)
        : `${ctx.base}/p/${product?.slug ?? ""}#comprar`;
    const now = Date.now();
    const rows: Prisma.StoreEmailCreateManyInput[] = [];
    for (const [i, step] of ctx.reminders.abandonedCheckout.steps.entries()) {
      const coupon = await couponIsUsable(order.companyId, step.couponByProduct?.[order.productId] ?? step.couponCode);
      const ctaUrl = withUtm(link, "abandoned_checkout", coupon ? { cupon: coupon } : undefined);
      const vars: EmailVars = { nombre: firstName(order.name) || "Hola", producto: order.productName, precio: price, link: ctaUrl, cupon: coupon ?? "", tienda: ctx.storeName };
      rows.push({
        companyId: order.companyId,
        customerId: order.customerId,
        orderId: order.id,
        kind: "ABANDONED_CHECKOUT",
        email,
        subject: fillVars(step.subject, vars),
        body: fillVars(step.body, vars),
        ctaLabel: "Completar mi compra",
        ctaUrl,
        couponCode: coupon,
        sendAt: new Date(now + step.delayMinutes * 60_000),
        metadata: { step: i + 1 },
      });
    }
    if (rows.length) await prisma.storeEmail.createMany({ data: rows });
  } catch (err) {
    console.warn("[store-email] no se pudo programar abandono:", err instanceof Error ? err.message : err);
  }
}

/** Cancela los correos pendientes de un pedido (al pagar, fallar o subir la captura). */
export async function cancelOrderEmails(orderId: string, reason: string, kinds: string[] = ["ABANDONED_CHECKOUT"]): Promise<void> {
  await prisma.storeEmail
    .updateMany({ where: { orderId, status: "PENDING", kind: { in: kinds } }, data: { status: "CANCELLED", failureReason: reason } })
    .catch(() => undefined);
}

/** Al entregar: correo post-compra a los N días con el producto relacionado y cupón. */
export async function schedulePostPurchase(order: OrderLike): Promise<void> {
  try {
    const email = order.email;
    if (!email) return;
    const ctx = await storeContext(order.companyId);
    if (!ctx || !ctx.reminders.postPurchase.enabled || !mailerEnabled()) return;
    if (await customerOptedOut(order.customerId)) return;
    const pp = ctx.reminders.postPurchase;
    const product = await prisma.product.findUnique({
      where: { id: order.productId },
      select: { slug: true, digitalDelivery: { select: { crossSellProductId: true } } },
    });
    const crossId = product?.digitalDelivery?.crossSellProductId;
    const cross = crossId ? await prisma.product.findFirst({ where: { id: crossId, companyId: order.companyId, active: true }, select: { name: true, slug: true } }) : null;
    const coupon = await couponIsUsable(order.companyId, pp.couponByProduct?.[order.productId] ?? pp.couponCode);
    const target = cross ? `${ctx.base}/p/${cross.slug}` : ctx.base;
    const ctaUrl = withUtm(target, "post_purchase", coupon ? { cupon: coupon } : undefined);
    const vars: EmailVars = {
      nombre: firstName(order.name) || "Hola",
      producto: order.productName,
      precio: orderPriceText(order),
      relacionado: cross?.name ?? "nuestros otros productos",
      link: ctaUrl,
      cupon: coupon ?? "",
      tienda: ctx.storeName,
    };
    await prisma.storeEmail.create({
      data: {
        companyId: order.companyId,
        customerId: order.customerId,
        orderId: order.id,
        kind: "POST_PURCHASE",
        email,
        subject: fillVars(pp.subject, vars),
        body: fillVars(pp.body, vars),
        ctaLabel: cross ? `Ver ${cross.name}` : "Ver la tienda",
        ctaUrl,
        couponCode: coupon,
        sendAt: new Date(Date.now() + pp.delayDays * 86_400_000),
      },
    });
  } catch (err) {
    console.warn("[store-email] no se pudo programar post-compra:", err instanceof Error ? err.message : err);
  }
}

/**
 * Tienda física: el post-compra sale a los N días de la ENTREGA, no del pago. Se llama
 * cuando el pedido real pasa a ENTREGADO; si el pedido no nació en la tienda, o ya tiene
 * su correo, no hace nada.
 */
export async function schedulePostPurchaseOnDelivery(companyId: string, orderId: string): Promise<void> {
  try {
    const so = await prisma.storeOrder.findFirst({ where: { companyId, orderId } });
    if (!so?.email) return;
    const already = await prisma.storeEmail.findFirst({ where: { orderId: so.id, kind: "POST_PURCHASE" }, select: { id: true } });
    if (already) return;
    await schedulePostPurchase(so);
  } catch (err) {
    console.warn("[store-email] no se pudo programar post-compra del pedido:", err instanceof Error ? err.message : err);
  }
}

/**
 * Tienda física: correo de «pedido recibido» para el comprador que dejó su correo. Es
 * transaccional (lo dispara su propia compra): sale aunque se haya dado de baja de las
 * promociones y no lleva cupón ni enlace de baja. Una sola vez por pedido.
 */
export async function queueOrderConfirmationEmail(p: {
  storeOrderId: string;
  companyId: string;
  customerId: string;
  email: string | null;
  name: string;
  code: string;
  lines: string[];
  total: string;
  /** Vacío si no pagó nada en la web (contra entrega). */
  paid: string;
  /** Vacío si no queda saldo. */
  balance: string;
  cod: boolean;
  delivery: string;
  trackingUrl: string;
}): Promise<void> {
  try {
    if (!p.email || !mailerEnabled()) return;
    const ctx = await storeContext(p.companyId);
    if (!ctx) return;
    const already = await prisma.storeEmail.findFirst({ where: { orderId: p.storeOrderId, kind: "ORDER_CONFIRMATION" }, select: { id: true } });
    if (already) return;
    const first = firstName(p.name);
    const detail = [
      `Total: ${p.total}`,
      p.cod ? "Pago: contra entrega" : p.paid ? `Pagado: ${p.paid}` : "",
      !p.cod && p.balance ? `Saldo por pagar: ${p.balance}` : "",
      p.delivery ? `Entrega: ${p.delivery}` : "",
    ].filter(Boolean);
    const body = [
      first ? `Hola ${first} 👋` : "Hola 👋",
      `Recibimos tu pedido ${p.code} en ${ctx.storeName}. Este es el resumen:`,
      p.lines.map((l) => `• ${l}`).join("\n"),
      detail.join("\n"),
      "Desde el botón de abajo puedes ver el estado de tu pedido cuando quieras.",
    ].join("\n\n");
    await prisma.storeEmail.create({
      data: {
        companyId: p.companyId,
        customerId: p.customerId,
        orderId: p.storeOrderId,
        kind: "ORDER_CONFIRMATION",
        email: p.email,
        subject: `Recibimos tu pedido ${p.code}`,
        body,
        ctaLabel: "Ver mi pedido",
        ctaUrl: withUtm(p.trackingUrl, "order_confirmation"),
        sendAt: new Date(),
      },
    });
  } catch (err) {
    console.warn("[store-email] no se pudo encolar el correo del pedido:", err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Suscripción (bloque del pie) y baja
// ---------------------------------------------------------------------------

function syntheticPhone(email: string): string {
  return `web:${crypto.createHash("sha256").update(email).digest("hex").slice(0, 12)}`;
}

export async function subscribeToStore(companyId: string, input: { email: string; name?: string | null }) {
  const email = normalizeEmail(input.email);
  if (!email) throw new AppError("El correo no es válido", 400);
  const ctx = await storeContext(companyId);
  if (!ctx) throw new AppError("Tienda no encontrada", 404);
  const phone = syntheticPhone(email);
  const existingByEmail = await prisma.customer.findFirst({ where: { companyId, email }, select: { id: true, metadata: true, name: true } });
  const name = (input.name ?? "").trim().slice(0, 120);
  let customerId: string;
  if (existingByEmail) {
    const md = (existingByEmail.metadata ?? {}) as Record<string, unknown>;
    await prisma.customer.update({
      where: { id: existingByEmail.id },
      data: { metadata: { ...md, emailMarketing: true, emailOptOut: false }, ...(existingByEmail.name || !name ? {} : { name }), lastInteractionAt: new Date() },
    });
    customerId = existingByEmail.id;
  } else {
    const c = await prisma.customer.upsert({
      where: { companyId_phone: { companyId, phone } },
      update: { email, lastInteractionAt: new Date(), metadata: { origin: "newsletter", emailMarketing: true, emailOptOut: false } },
      create: { companyId, phone, name: name || null, email, status: "activo", lastInteractionAt: new Date(), metadata: { origin: "newsletter", emailMarketing: true, emailOptOut: false } },
      select: { id: true },
    });
    customerId = c.id;
  }
  // Bienvenida (una sola vez por correo).
  const w = ctx.reminders.welcome;
  const already = await prisma.storeEmail.findFirst({ where: { companyId, email, kind: "WELCOME" }, select: { id: true } });
  if (w.enabled && mailerEnabled() && !already) {
    const coupon = await couponIsUsable(companyId, w.couponCode);
    const ctaUrl = withUtm(ctx.base, "welcome", coupon ? { cupon: coupon } : undefined);
    const vars: EmailVars = { nombre: firstName(name) || "Hola", tienda: ctx.storeName, link: ctaUrl, cupon: coupon ?? "" };
    await prisma.storeEmail.create({
      data: { companyId, customerId, kind: "WELCOME", email, subject: fillVars(w.subject, vars), body: fillVars(w.body, vars), ctaLabel: "Ver la tienda", ctaUrl, couponCode: coupon, sendAt: new Date() },
    });
  }
  return { ok: true, mensaje: "¡Listo! Te avisaremos de las nuevas ofertas." };
}

export function unsubUrlFor(companyId: string, customerId: string): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/public/store/unsub?t=${encodeURIComponent(signEmailUnsubToken({ companyId, customerId }))}`;
}

/** Marca la baja y devuelve el nombre de la tienda para la página de confirmación. */
export async function unsubscribeByToken(token: string): Promise<{ storeName: string; storeLink: string }> {
  let payload;
  try {
    payload = verifyEmailUnsubToken(token);
  } catch {
    throw new AppError("El enlace de baja no es válido", 400);
  }
  const c = await prisma.customer.findFirst({ where: { id: payload.customerId, companyId: payload.companyId }, select: { id: true, metadata: true, email: true } });
  if (!c) throw new AppError("Contacto no encontrado", 404);
  const md = (c.metadata ?? {}) as Record<string, unknown>;
  await prisma.customer.update({ where: { id: c.id }, data: { metadata: { ...md, emailOptOut: true, emailMarketing: false, emailOptOutAt: new Date().toISOString() } } });
  if (c.email) {
    await prisma.storeEmail.updateMany({ where: { companyId: payload.companyId, email: c.email, status: "PENDING" }, data: { status: "CANCELLED", failureReason: "Se dio de baja" } });
  }
  const ctx = await storeContext(payload.companyId);
  return { storeName: ctx?.storeName ?? "la tienda", storeLink: ctx?.base ?? "" };
}

// ---------------------------------------------------------------------------
// Worker: envío de los pendientes (ritmo y tope diario)
// ---------------------------------------------------------------------------

export async function processStoreEmails(): Promise<number> {
  if (!mailerEnabled()) return 0;
  const due = await prisma.storeEmail.findMany({
    where: { status: "PENDING", sendAt: { lte: new Date() } },
    orderBy: { sendAt: "asc" },
    take: env.STORE_EMAIL_PER_MINUTE,
  });
  if (!due.length) return 0;
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const ctxCache = new Map<string, Awaited<ReturnType<typeof storeContext>>>();
  const sentToday = new Map<string, number>();
  let sent = 0;
  for (const m of due) {
    try {
      // Reclamar la fila (evita doble envío si el worker se solapa).
      const claimed = await prisma.storeEmail.updateMany({ where: { id: m.id, status: "PENDING" }, data: { status: "SENDING" } });
      if (!claimed.count) continue;
      // El correo del pedido es transaccional: la baja de promociones no lo frena.
      const transactional = m.kind === "ORDER_CONFIRMATION";
      if (!transactional && (await customerOptedOut(m.customerId))) {
        await prisma.storeEmail.update({ where: { id: m.id }, data: { status: "CANCELLED", failureReason: "Se dio de baja" } });
        continue;
      }
      // El pedido ya se pagó/falló entre medio: no insistir.
      if (m.orderId && m.kind === "ABANDONED_CHECKOUT") {
        const o = await prisma.storeOrder.findUnique({ where: { id: m.orderId }, select: { status: true, receiptMediaUrl: true } });
        if (!o || o.status !== "PENDIENTE" || o.receiptMediaUrl) {
          await prisma.storeEmail.update({ where: { id: m.id }, data: { status: "CANCELLED", failureReason: "El pedido ya no está pendiente" } });
          continue;
        }
      }
      if (!sentToday.has(m.companyId)) {
        sentToday.set(m.companyId, await prisma.storeEmail.count({ where: { companyId: m.companyId, status: "SENT", sentAt: { gte: startOfDay } } }));
      }
      if ((sentToday.get(m.companyId) ?? 0) >= env.STORE_EMAIL_DAILY_CAP) {
        // Tope diario: vuelve a PENDING para mañana.
        await prisma.storeEmail.update({ where: { id: m.id }, data: { status: "PENDING", sendAt: new Date(startOfDay.getTime() + 86_400_000 + 60_000) } });
        continue;
      }
      if (!ctxCache.has(m.companyId)) ctxCache.set(m.companyId, await storeContext(m.companyId));
      const ctx = ctxCache.get(m.companyId);
      if (!ctx) {
        await prisma.storeEmail.update({ where: { id: m.id }, data: { status: "FAILED", failureReason: "Tienda no configurada" } });
        continue;
      }
      const { html, text } = renderStoreEmail({
        storeName: ctx.storeName,
        accent: ctx.accent,
        logoUrl: ctx.cfg.logoUrl,
        subject: m.subject,
        body: m.body,
        ctaLabel: m.ctaLabel,
        ctaUrl: m.ctaUrl,
        couponCode: m.couponCode,
        unsubUrl: m.customerId && !transactional ? unsubUrlFor(m.companyId, m.customerId) : null,
        storeLink: ctx.base,
      });
      await sendMail({ to: m.email, subject: m.subject, html, text, fromName: `${ctx.storeName} vía FlowApp` });
      await prisma.storeEmail.update({ where: { id: m.id }, data: { status: "SENT", sentAt: new Date() } });
      sentToday.set(m.companyId, (sentToday.get(m.companyId) ?? 0) + 1);
      sent += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      await prisma.storeEmail.update({ where: { id: m.id }, data: { status: "FAILED", failureReason: msg.slice(0, 300) } }).catch(() => undefined);
      console.warn(`[store-email] fallo enviando ${m.id}: ${msg}`);
    }
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Panel: historial, stats, prueba
// ---------------------------------------------------------------------------

export async function listStoreEmails(companyId: string, kind?: string, limit = 50) {
  const since7 = new Date(Date.now() - 7 * 86_400_000);
  const [items, pendientes, enviados7d, fallidos7d, bajas] = await Promise.all([
    prisma.storeEmail.findMany({
      where: { companyId, ...(kind ? { kind } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, kind: true, email: true, subject: true, status: true, sendAt: true, sentAt: true, failureReason: true, orderId: true, couponCode: true, createdAt: true },
    }),
    prisma.storeEmail.count({ where: { companyId, status: "PENDING" } }),
    prisma.storeEmail.count({ where: { companyId, status: "SENT", sentAt: { gte: since7 } } }),
    prisma.storeEmail.count({ where: { companyId, status: "FAILED", updatedAt: { gte: since7 } } }),
    prisma.customer.count({ where: { companyId, metadata: { path: ["emailOptOut"], equals: true } } }),
  ]);
  return { items, stats: { pendientes, enviados7d, fallidos7d, bajas, habilitado: mailerEnabled(), topeDiario: env.STORE_EMAIL_DAILY_CAP } };
}

/** "Enviarme una prueba": renderiza un paso con datos de ejemplo y lo manda al correo indicado. */
export async function sendStoreTestEmail(companyId: string, input: { to: string; subject: string; body: string; couponCode?: string | null; kind?: string }) {
  const to = normalizeEmail(input.to);
  if (!to) throw new AppError("Correo de destino inválido", 400);
  if (!mailerEnabled()) throw new AppError("El envío de correos no está disponible en esta instalación", 409);
  const ctx = await storeContext(companyId);
  if (!ctx) throw new AppError("Tienda no configurada", 404);
  const product = await prisma.product.findFirst({ where: { companyId, active: true }, select: { name: true, slug: true }, orderBy: { sortOrder: "asc" } });
  const coupon = (input.couponCode ?? "").trim().toUpperCase() || "PROMO10";
  const link = withUtm(product ? `${ctx.base}/p/${product.slug}` : ctx.base, input.kind ?? "test");
  const vars: EmailVars = { nombre: "Ana", producto: product?.name ?? "Tu producto", precio: `${symbolFor(ctx.company.currency)} 10.00`, relacionado: "nuestro pack recomendado", link, cupon: coupon, tienda: ctx.storeName };
  const subject = `[Prueba] ${fillVars(input.subject, vars)}`;
  const body = fillVars(input.body, vars);
  const { html, text } = renderStoreEmail({ storeName: ctx.storeName, accent: ctx.accent, logoUrl: ctx.cfg.logoUrl, subject, body, ctaLabel: "Ver la tienda", ctaUrl: link, couponCode: coupon, unsubUrl: null, storeLink: ctx.base });
  await sendMail({ to, subject, html, text, fromName: `${ctx.storeName} vía FlowApp` });
  return { ok: true };
}
