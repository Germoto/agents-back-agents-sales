/**
 * Tienda web pública por tenant (<slug>.<STORE_DOMAIN> o /tienda/<slug>).
 *
 * MVP infoproductos: catálogo del tenant (solo digitales con entrega por correo),
 * checkout de UN producto con Mercado Pago o con Yape/Plin (el comprador sube el
 * comprobante: visión + matching contra los comprobantes PENDIENTES, igual que el
 * chat; sin match queda EN_REVISION y el dueño lo aprueba desde el panel) y
 * entrega automática por correo (+ WhatsApp si dejó su número). Reutiliza:
 * mpCreatePreference, webhook MP (rama storeOrderId), readReceiptImage,
 * matchPayments/claimPayment/updatePaymentStatus, sendDigitalDeliveryEmail,
 * handleExternalPaymentApproved, gateNewLead/getEntitlements.
 *
 * Nada de esto toca el flujo del agente: módulo aparte, tablas nuevas.
 */

import crypto from "crypto";
import { Prisma, type StoreOrderStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { env } from "../../config/env";
import { decryptCredential } from "../../lib/credentials-crypto";
import { mpCreatePreference, mpLinkAmount, type MpPayment } from "../../lib/mercadopago-client";
import { mapBotProduct, productRelations } from "../../lib/product";
import { symbolFor } from "../../lib/currency";
import { normalizeEmail } from "../../lib/email";
import { isValidStoreSlug, storeSlugProblem } from "../../lib/slug";
import { getEntitlements } from "../billing/entitlements";
import { gateNewLead } from "../billing/billing.service";
import { socketService, SOCKET_EVENTS } from "../../lib/socket";
import { normalizePhone, loadOrCreateConversation, notifyOwner } from "../agent/conversation.service";
import { sendDigitalDeliveryEmail, EmailDeliveryError } from "../agent/email-delivery";
import { handleExternalPaymentApproved } from "../agent/agent.service";
import { loadWhatsappSender, sendMedia } from "../agent/outbound";
import { buildBotConfig } from "../bot/bot.service";
import { readReceiptImage } from "../agent/receipt-vision";
import { claimPayment, matchPayments, updatePaymentStatus } from "../public-payments/public-payments.service";
import type { AiSettings } from "../../lib/ai-providers";

// ---------------------------------------------------------------------------
// URL y resolución
// ---------------------------------------------------------------------------

/** URL pública de la tienda de un slug (subdominio en prod; path en desarrollo). */
export function storeUrl(slug: string): string {
  if (env.STORE_DOMAIN) return `https://${slug}.${env.STORE_DOMAIN}`;
  const base = (env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
  return `${base}/tienda/${slug}`;
}

type StoreCompany = {
  id: string;
  name: string;
  slug: string;
  currency: string;
  timezone: string;
  isActive: boolean;
};

/** Empresa + config de tienda por slug. Lanza 404 si no existe o no está activa. */
async function resolveStore(slug: string) {
  const s = slug.trim().toLowerCase();
  if (!isValidStoreSlug(s)) throw new AppError("Tienda no encontrada", 404);
  const company = await prisma.company.findUnique({
    where: { slug: s },
    select: { id: true, name: true, slug: true, currency: true, timezone: true, isActive: true },
  });
  if (!company || !company.isActive) throw new AppError("Tienda no encontrada", 404);
  const cfg = await prisma.storefrontConfig.findUnique({ where: { companyId: company.id } });
  if (!cfg || !cfg.enabled) throw new AppError("Tienda no encontrada", 404);
  const ent = await getEntitlements(company.id);
  if (ent.blocked || !(ent.legacy || ent.modules.includes("STOREFRONT"))) {
    throw new AppError("Tienda no disponible", 404);
  }
  return { company: company as StoreCompany, cfg, ent };
}

/**
 * Hosts fijos de la plataforma bajo el dominio base. Con un site `*.<dominio>`
 * en on_demand, Caddy agrupa bajo esa política a los subdominios sin opciones
 * `tls` propias (api, www) y consulta el `ask` también para ellos: si se
 * rechazan, su TLS se cae. Siempre se aprueban.
 */
const PLATFORM_HOSTS = new Set(["api", "www", "app"]);

/** Caddy on_demand_tls `ask`: 200 si el host es una tienda activa o un host fijo de la plataforma. Cache 60 s. */
const tlsAskCache = new Map<string, { ok: boolean; ts: number }>();
export async function tlsAsk(domain: string): Promise<boolean> {
  const host = domain.trim().toLowerCase();
  if (!env.STORE_DOMAIN) return false;
  if (host === env.STORE_DOMAIN) return true;
  if (!host.endsWith(`.${env.STORE_DOMAIN}`)) return false;
  const slug = host.slice(0, -(env.STORE_DOMAIN.length + 1));
  if (PLATFORM_HOSTS.has(slug)) return true;
  if (!isValidStoreSlug(slug)) return false;
  const hit = tlsAskCache.get(host);
  if (hit && Date.now() - hit.ts < 60_000) return hit.ok;
  let ok = false;
  try {
    await resolveStore(slug);
    ok = true;
  } catch {
    ok = false;
  }
  tlsAskCache.set(host, { ok, ts: Date.now() });
  return ok;
}

// ---------------------------------------------------------------------------
// Catálogo público
// ---------------------------------------------------------------------------

/** Productos elegibles: digitales, activos, en catálogo, entrega fija y con correo. */
async function eligibleProducts(companyId: string, productIds: string[]) {
  const rows = await prisma.product.findMany({
    where: {
      companyId,
      active: true,
      showInCatalog: true,
      productType: "DIGITAL",
      ...(productIds.length ? { id: { in: productIds } } : {}),
      digitalDelivery: { is: { assignmentMode: "STATIC", emailEnabled: true } },
    },
    include: productRelations,
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return rows;
}

/** Métodos de pago disponibles en la tienda (MP y/o Yape-Plin manual). */
async function storePaymentOptions(companyId: string, cfg: { manualPaymentsEnabled: boolean }, ent: { legacy: boolean; modules: string[] }) {
  const pc = await prisma.paymentConfig.findUnique({
    where: { companyId },
    include: { methods: { orderBy: { sortOrder: "asc" } } },
  });
  const mpModule = ent.legacy || ent.modules.includes("MERCADOPAGO");
  const mercadoPago = Boolean(mpModule && pc?.mpEnabled && pc.mpAccessToken && pc.mpStoreEnabled);
  const manual =
    pc?.enabled && cfg.manualPaymentsEnabled
      ? pc.methods.map((m) => ({ method: m.method, number: m.number, holder: m.holder }))
      : [];
  return { mercadoPago, manual, pc };
}

export async function getPublicStore(slug: string) {
  const { company, cfg, ent } = await resolveStore(slug);
  const symbol = symbolFor(company.currency);
  const products = await eligibleProducts(company.id, cfg.productIds);
  const pay = await storePaymentOptions(company.id, cfg, ent);
  return {
    pagos: { mercadoPago: pay.mercadoPago, manual: pay.manual },
    negocio: {
      slug: company.slug,
      name: company.name,
      title: cfg.title || company.name,
      tagline: cfg.tagline || null,
      accentColor: cfg.accentColor || null,
      logoUrl: cfg.logoUrl || null,
      currency: company.currency,
      whatsappNumber: cfg.whatsappNumber ? cfg.whatsappNumber.replace(/\D/g, "") || null : null,
    },
    productos: products.map((p) => {
      const b = mapBotProduct(p, { currencySymbol: symbol, timezone: company.timezone });
      return {
        id: b.id,
        slug: b.slug,
        name: b.name,
        price: b.price,
        priceText: b.priceText,
        regularPriceText: b.regularPriceText,
        offerActive: b.offerActive,
        offerEndsText: b.offerEndsText,
        shortDescription: b.shortDescription,
        fullDescription: b.fullDescription,
        category: b.category,
        benefits: b.benefits,
        includes: b.includes,
        bonuses: b.bonuses,
        faqs: b.faqs.map((f) => ({ question: f.question, answer: f.answer })),
        // Solo imágenes de presentación (nunca los archivos de entrega).
        images: p.files
          .filter((f) => f.type === "IMAGE" && f.showInPresentation)
          .map((f) => ({ url: f.url, description: f.description || "" })),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Previews al compartir (Open Graph) — HTML mínimo para los bots de WhatsApp/Meta
// ---------------------------------------------------------------------------

function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** Slug de tienda a partir del host (subdominio) o del path (/tienda/<slug>/...). */
export function storeSlugFromHostOrPath(host: string, path: string): { slug: string; rest: string } | null {
  const h = host.trim().toLowerCase().split(":")[0];
  if (env.STORE_DOMAIN && h.endsWith(`.${env.STORE_DOMAIN}`)) {
    const slug = h.slice(0, -(env.STORE_DOMAIN.length + 1));
    if (!PLATFORM_HOSTS.has(slug) && isValidStoreSlug(slug)) return { slug, rest: path };
  }
  const m = /^\/tienda\/([a-z0-9-]+)(\/.*)?$/i.exec(path);
  if (m) return { slug: m[1].toLowerCase(), rest: m[2] ?? "/" };
  return null;
}

/**
 * HTML con etiquetas Open Graph para la tienda o un producto (`/p/<slug>`), con
 * redirección inmediata a la misma URL para humanos. Caddy enruta aquí solo a los
 * bots (User-Agent de WhatsApp, Facebook, Telegram, etc.); sin esa regla la tienda
 * funciona igual, solo no hay preview al compartir el link.
 */
export async function getStoreOgHtml(host: string, path: string): Promise<string | null> {
  const target = storeSlugFromHostOrPath(host, path);
  if (!target) return null;
  let resolved;
  try {
    resolved = await resolveStore(target.slug);
  } catch {
    return null;
  }
  const { company, cfg } = resolved;
  const base = storeUrl(company.slug);
  const symbol = symbolFor(company.currency);
  const title0 = cfg.title || company.name;

  let title = title0;
  let description = cfg.tagline || `Tienda online de ${company.name}`;
  let image = cfg.logoUrl || "";
  let url = base;

  const pm = /^\/p\/([^/?#]+)/.exec(target.rest || "/");
  if (pm) {
    const key = decodeURIComponent(pm[1]);
    const products = await eligibleProducts(company.id, cfg.productIds);
    const product = products.find((p) => p.slug === key || p.id === key);
    if (product) {
      const b = mapBotProduct(product, { currencySymbol: symbol, timezone: company.timezone });
      title = `${product.name} · ${title0}`;
      const price = b.priceText ?? b.price;
      description = [price ? `${price}` : null, b.shortDescription || b.fullDescription?.slice(0, 160) || null].filter(Boolean).join(" — ");
      const img = product.files.find((f) => f.type === "IMAGE" && f.showInPresentation);
      if (img) image = img.url;
      url = `${base}/p/${encodeURIComponent(product.slug)}`;
    }
  }

  const t = escapeHtml(title);
  const d = escapeHtml(description.slice(0, 300));
  const u = escapeHtml(url);
  const img = image ? `<meta property="og:image" content="${escapeHtml(image)}"><meta name="twitter:image" content="${escapeHtml(image)}">` : "";
  return (
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${t}</title>` +
    `<meta name="description" content="${d}">` +
    `<meta property="og:type" content="${pm ? "product" : "website"}"><meta property="og:site_name" content="${escapeHtml(title0)}">` +
    `<meta property="og:title" content="${t}"><meta property="og:description" content="${d}"><meta property="og:url" content="${u}">${img}` +
    `<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}"><meta name="twitter:title" content="${t}"><meta name="twitter:description" content="${d}">` +
    `<meta http-equiv="refresh" content="0;url=${u}"><link rel="canonical" href="${u}"></head>` +
    `<body><a href="${u}">${t}</a></body></html>`
  );
}

// ---------------------------------------------------------------------------
// Checkout (Mercado Pago)
// ---------------------------------------------------------------------------

function parsePrice(v: string | null | undefined): number {
  const n = parseFloat(String(v ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** Teléfono sintético estable por comprador sin WhatsApp (ignorado por scheduler/campañas). */
function syntheticPhone(email: string): string {
  return `web:${crypto.createHash("sha256").update(email).digest("hex").slice(0, 12)}`;
}

export type StoreCheckoutMethod = "MERCADOPAGO" | "MANUAL";

export type StoreOrderItem = { productId: string; name: string; unitPrice: number; qty: number };

/** Ids de producto de un pedido (carrito o pedido antiguo de un solo producto). */
export function orderProductIds(order: { productId: string; productIds: string[] }): string[] {
  return order.productIds.length ? order.productIds : [order.productId];
}

export async function createStoreCheckout(
  slug: string,
  input: { productId?: string; productIds?: string[]; name: string; email: string; phone?: string | null; method?: StoreCheckoutMethod },
) {
  const { company, cfg, ent } = await resolveStore(slug);
  const companyId = company.id;
  const method: StoreCheckoutMethod = input.method === "MANUAL" ? "MANUAL" : "MERCADOPAGO";

  const email = normalizeEmail(input.email);
  if (!email) throw new AppError("El correo no es válido", 400);
  const name = input.name.trim();
  const digits = (input.phone ?? "").replace(/\D/g, "");
  if (digits && digits.length < 8) throw new AppError("El número de WhatsApp no es válido", 400);

  const pay = await storePaymentOptions(companyId, cfg, ent);
  const pc = pay.pc;
  if (method === "MERCADOPAGO" && (!pay.mercadoPago || !pc?.mpAccessToken)) {
    throw new AppError("Esta tienda aún no tiene pagos con Mercado Pago habilitados", 409);
  }
  if (method === "MANUAL" && !pay.manual.length) {
    throw new AppError("Esta tienda no acepta pago con Yape/Plin por el momento", 409);
  }

  // Carrito: ids únicos, todos elegibles, precio de lista por producto (digitales: qty 1).
  const wantedIds = Array.from(new Set([...(input.productIds ?? []), ...(input.productId ? [input.productId] : [])]));
  if (!wantedIds.length) throw new AppError("Elige al menos un producto", 400);
  const eligible = await eligibleProducts(companyId, cfg.productIds);
  const chosen = wantedIds.map((id) => eligible.find((p) => p.id === id)).filter((p): p is (typeof eligible)[number] => Boolean(p));
  if (chosen.length !== wantedIds.length) throw new AppError(chosen.length ? "Algún producto del carrito ya no está disponible" : "Producto no disponible", 404);
  const items: StoreOrderItem[] = chosen.map((p) => {
    const bot = mapBotProduct(p, { currencySymbol: symbolFor(company.currency), timezone: company.timezone });
    const unitPrice = parsePrice(bot.price);
    if (unitPrice <= 0) throw new AppError(`«${p.name}» no tiene un precio válido para compra online`, 409);
    return { productId: p.id, name: p.name, unitPrice, qty: 1 };
  });
  const product = chosen[0];
  const priceNum = Number(items.reduce((acc, it) => acc + it.unitPrice * it.qty, 0).toFixed(2));
  const productName = items.length > 1 ? `${product.name} +${items.length - 1} más` : product.name;
  // Yape/Plin: precio de lista exacto (sin recargo). MP: link con la comisión según config.
  const linkAmount =
    method === "MANUAL" || !pc
      ? priceNum
      : mpLinkAmount(priceNum, {
          feeMode: pc.mpFeeMode,
          feePercent: Number(pc.mpFeePercent),
          feeFixed: Number(pc.mpFeeFixed),
          feeIgv: pc.mpFeeIgv,
        });

  // Cliente: WhatsApp real si lo dio; si no, teléfono sintético estable por email.
  const phone = digits ? normalizePhone(digits) : syntheticPhone(email);
  const existing = await prisma.customer.findUnique({
    where: { companyId_phone: { companyId, phone } },
    select: { id: true, name: true, email: true },
  });
  if (!ent.legacy && !existing) {
    const allowed = await gateNewLead(companyId, phone);
    if (!allowed) throw new AppError("La tienda no puede recibir compras por el momento", 503);
  }
  const customer = await prisma.customer.upsert({
    where: { companyId_phone: { companyId, phone } },
    update: {
      lastInteractionAt: new Date(),
      email,
      ...(existing?.name ? {} : { name }),
    },
    create: {
      companyId,
      phone,
      name,
      email,
      status: "activo",
      lastInteractionAt: new Date(),
      metadata: { origin: "storefront" },
    },
    select: { id: true },
  });

  const accessToken = crypto.randomBytes(18).toString("base64url");
  const order = await prisma.storeOrder.create({
    data: {
      companyId,
      customerId: customer.id,
      productId: product.id,
      productName,
      items,
      productIds: items.map((it) => it.productId),
      email,
      name,
      phone: digits ? phone : null,
      amount: new Prisma.Decimal(linkAmount.toFixed(2)),
      currency: company.currency,
      paymentMethod: method,
      accessToken,
      metadata: { listPrice: priceNum, feeMode: pc?.mpFeeMode ?? null },
    },
  });

  const base = storeUrl(company.slug);
  const thanks = `${base}/gracias?o=${order.id}&t=${accessToken}`;
  const amountText = `${symbolFor(company.currency)} ${linkAmount.toFixed(2)}`;

  if (method === "MANUAL") {
    return {
      orderId: order.id,
      token: accessToken,
      method,
      initPoint: null,
      amount: linkAmount,
      amountText,
      feeIncluded: false,
      metodos: pay.manual,
      items,
    };
  }

  const https = base.startsWith("https://");
  let pref;
  try {
    // Varios ítems: cada producto a su precio de lista y, si el negocio traslada la
    // comisión, un ítem extra con el recargo (así el total del link = linkAmount).
    const fee = Number((linkAmount - priceNum).toFixed(2));
    const mpItems = [
      ...items.map((it) => ({ title: it.name, amount: it.unitPrice, quantity: it.qty })),
      ...(fee > 0 ? [{ title: "Comisión de pago", amount: fee, quantity: 1 }] : []),
    ];
    pref = await mpCreatePreference(decryptCredential(pc!.mpAccessToken!), {
      title: productName,
      amount: linkAmount,
      items: mpItems,
      currency: company.currency.toUpperCase(),
      externalReference: JSON.stringify({ storeOrderId: order.id }),
      notificationUrl: `${env.PUBLIC_BASE_URL}/api/webhooks/mercadopago/${companyId}`,
      backUrls: { success: thanks, failure: `${thanks}&r=failure`, pending: `${thanks}&r=pending` },
      autoReturn: https,
    });
  } catch (err) {
    await prisma.storeOrder.update({
      where: { id: order.id },
      data: { status: "FALLIDO", failureReason: `Mercado Pago: ${err instanceof Error ? err.message : "error"}` },
    });
    console.error(`[storefront] MP preference falló company=${companyId}:`, err instanceof Error ? err.message : err);
    throw new AppError("No se pudo iniciar el pago. Intenta de nuevo en un momento.", 502);
  }
  await prisma.storeOrder.update({ where: { id: order.id }, data: { mpPreferenceId: pref.id } });

  return {
    orderId: order.id,
    token: accessToken,
    method,
    initPoint: pref.init_point,
    amount: linkAmount,
    amountText,
    feeIncluded: linkAmount > priceNum,
    metodos: [] as { method: string; number: string; holder: string }[],
    items,
  };
}

// ---------------------------------------------------------------------------
// Estado del pedido (página de gracias)
// ---------------------------------------------------------------------------

export async function getPublicOrder(id: string, token: string) {
  const order = await prisma.storeOrder.findUnique({ where: { id } });
  if (!order || order.accessToken !== token) throw new AppError("Pedido no encontrado", 404);
  const manual = order.paymentMethod === "MANUAL";
  const mensaje: Record<StoreOrderStatus, string> = {
    PENDIENTE: manual
      ? order.receiptMediaUrl
        ? "Estamos validando tu pago…"
        : "Realiza el pago y sube la captura del comprobante para validarlo."
      : "Esperando la confirmación del pago…",
    EN_REVISION: "Recibimos tu comprobante. Un asesor lo revisa en breve y te enviamos el acceso a tu correo.",
    PAGADO: "Pago confirmado. Preparando tu acceso…",
    ENTREGADO: `Listo: te enviamos el acceso a ${order.email}. Si no lo ves, revisa spam o promociones.`,
    FALLIDO: "Hubo un inconveniente con tu pedido. Escríbenos y lo resolvemos.",
  };
  let pagoManual: { amountText: string; metodos: { method: string; number: string; holder: string }[]; comprobanteSubido: boolean } | null = null;
  if (manual) {
    const [cfg, ent] = await Promise.all([
      prisma.storefrontConfig.findUnique({ where: { companyId: order.companyId }, select: { manualPaymentsEnabled: true } }),
      getEntitlements(order.companyId),
    ]);
    const pay = await storePaymentOptions(order.companyId, { manualPaymentsEnabled: cfg?.manualPaymentsEnabled ?? true }, ent);
    pagoManual = {
      amountText: `${symbolFor(order.currency)} ${Number(order.amount).toFixed(2)}`,
      metodos: pay.manual,
      comprobanteSubido: Boolean(order.receiptMediaUrl),
    };
  }
  const items = (Array.isArray(order.items) ? (order.items as unknown as StoreOrderItem[]) : null) ?? [];
  return {
    id: order.id,
    status: order.status,
    paymentMethod: order.paymentMethod,
    productName: order.productName,
    productos: items.length ? items.map((it) => it.name) : [order.productName],
    email: order.email,
    deliveredAt: order.deliveredAt,
    mensaje: mensaje[order.status],
    pagoManual,
  };
}

// ---------------------------------------------------------------------------
// Entrega de un pedido pagado (común a Mercado Pago, Yape/Plin y aprobación manual)
// ---------------------------------------------------------------------------

type StoreOrderRow = Prisma.StoreOrderGetPayload<Record<string, never>>;

/**
 * Marca el pedido PAGADO con su comprobante, entrega por correo (+ WhatsApp si
 * dejó número real), deja ENTREGADO/FALLIDO y avisa al dueño. Idempotente por
 * estado: si ya está PAGADO/ENTREGADO no vuelve a entregar.
 */
export async function fulfillStoreOrder(
  order: StoreOrderRow,
  receiptId: string,
  opts: { paid: number; payerName: string; providerLabel: string; extraData?: Prisma.StoreOrderUpdateInput },
) {
  const companyId = order.companyId;
  if (order.status === "PAGADO" || order.status === "ENTREGADO") return { ok: true, duplicate: true as const, receiptId };

  await prisma.storeOrder.update({
    where: { id: order.id },
    data: { status: "PAGADO", receiptId, ...(opts.extraData ?? {}) },
  });

  const amountText = `${symbolFor(order.currency)} ${opts.paid.toFixed(2)}`;

  // Entrega por correo (requisito del MVP) + WhatsApp si dejó número real.
  let emailOk = false;
  let failure: string | null = null;
  try {
    await sendDigitalDeliveryEmail({ companyId, customerId: order.customerId, receiptId, email: order.email, trigger: "web" });
    emailOk = true;
  } catch (err) {
    failure = err instanceof EmailDeliveryError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : "error";
    console.error(`[storefront] entrega por correo falló order=${order.id}: ${failure}`);
  }

  let waDelivered = false;
  if (order.phone && !order.phone.startsWith("web:")) {
    try {
      const sender = await loadWhatsappSender(companyId);
      if (sender) {
        const convo = await loadOrCreateConversation(companyId, order.phone, null);
        await handleExternalPaymentApproved({
          companyId,
          conversationId: convo.conversationId,
          productIds: orderProductIds(order),
          amountText,
          payerName: opts.payerName,
          provider: opts.providerLabel,
        });
        waDelivered = true;
      }
    } catch (err) {
      console.warn(`[storefront] entrega por WhatsApp falló order=${order.id}:`, err instanceof Error ? err.message : err);
    }
  }

  const delivered = emailOk || waDelivered;
  await prisma.storeOrder.update({
    where: { id: order.id },
    data: delivered
      ? { status: "ENTREGADO", deliveredAt: new Date(), failureReason: failure, metadata: { ...((order.metadata as object) ?? {}), emailOk, waDelivered } }
      : { status: "FALLIDO", failureReason: failure ?? "sin canal de entrega" },
  });

  // Aviso al dueño (handleExternalPaymentApproved ya avisa cuando hubo WhatsApp).
  if (!waDelivered) {
    void notifyOwner(
      companyId,
      delivered
        ? `🛒 Venta en tu tienda web (${opts.providerLabel}): *${order.productName}* · ${amountText} · ${order.email}. Acceso enviado por correo ✅`
        : `⚠️ Venta en tu tienda web (${order.productName} · ${amountText} · ${order.email}) PAGADA pero no se pudo entregar: ${failure}. Reenvía el acceso desde la ficha del cliente.`,
    ).catch(() => undefined);
  }
  console.log(`[storefront] pedido ${order.id} ${delivered ? "ENTREGADO" : "FALLIDO"} email=${emailOk} wa=${waDelivered}`);
  return { ok: true, receiptId };
}

// ---------------------------------------------------------------------------
// Webhook de Mercado Pago → pedido web pagado → entrega
// ---------------------------------------------------------------------------

/**
 * Rama "pedido web" del webhook MP. Idempotente: si el pedido ya está PAGADO/
 * ENTREGADO o el receipt (source, externalId) ya existe, no hace nada.
 */
export async function fulfillStoreOrderFromMp(companyId: string, storeOrderId: string, payment: MpPayment) {
  const order = await prisma.storeOrder.findFirst({ where: { id: storeOrderId, companyId } });
  if (!order) return { ok: true, ignored: true as const };
  if (order.status === "PAGADO" || order.status === "ENTREGADO") return { ok: true, duplicate: true as const };

  const paid = Number(payment.transaction_amount ?? 0);
  const expected = Number(order.amount);
  const externalId = String(payment.id);
  const payerName =
    [payment.payer?.first_name, payment.payer?.last_name].filter(Boolean).join(" ").trim() || order.name;

  if (paid + 0.01 < expected) {
    await prisma.storeOrder.update({
      where: { id: order.id },
      data: { status: "FALLIDO", mpPaymentId: externalId, failureReason: `Monto pagado ${paid} menor al pedido ${expected}` },
    });
    void notifyOwner(
      companyId,
      `⚠️ Pago de tu tienda web por un monto menor al pedido (${paid} vs ${expected}) — ${order.productName} · ${order.email}. No se entregó.`,
    ).catch(() => undefined);
    return { ok: true, ignored: true as const };
  }

  let receiptId: string;
  try {
    const receipt = await prisma.paymentReceipt.create({
      data: {
        companyId,
        customerId: order.customerId,
        productId: order.productId,
        productIds: orderProductIds(order),
        amountExpected: String(paid),
        amountPaid: String(paid),
        currency: payment.currency_id ?? order.currency,
        status: "APROBADO",
        source: "mercadopago",
        externalId,
        payerName,
        paymentSource: "mercadopago",
        occurredAt: payment.date_approved ? new Date(payment.date_approved) : new Date(),
        validatedAt: new Date(),
        validationMode: "AUTO",
        validationNote: "Compra en la tienda web confirmada por Mercado Pago (webhook + verificación API)",
        metadata: { channel: "storefront", storeOrderId: order.id, mpPaymentId: externalId, email: order.email },
      },
    });
    receiptId = receipt.id;
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") return { ok: true, duplicate: true as const };
    throw err;
  }
  socketService.emitToCompany(companyId, SOCKET_EVENTS.RECEIPT_NEW, { receiptId, source: "mercadopago" });

  return fulfillStoreOrder(order, receiptId, {
    paid,
    payerName,
    providerLabel: "Mercado Pago (tienda web)",
    extraData: { mpPaymentId: externalId },
  });
}

// ---------------------------------------------------------------------------
// Pago con Yape/Plin: comprobante subido → visión → matching → entrega
// ---------------------------------------------------------------------------

/** Reintentos del matching (worker, 1/min) antes de avisar al dueño: ValidPay puede llegar tarde. */
export const STORE_RECHECK_MAX = 10;

type StoreReceiptMeta = {
  amountText: string | null;
  operationNumber: string | null;
  securityCode: string | null;
  isReceipt: boolean | null;
  description: string | null;
};

function receiptMetaOf(order: StoreOrderRow): StoreReceiptMeta | null {
  const md = (order.metadata ?? {}) as Record<string, unknown>;
  const r = md.receipt as StoreReceiptMeta | undefined;
  return r && typeof r === "object" ? r : null;
}

/**
 * Intenta aprobar el pedido manual con las señales disponibles (misma regla
 * estricta que el chat: el mejor candidato debe coincidir por código exacto o
 * por nombre del pagador). Devuelve true si entregó. No lanza.
 */
export async function tryMatchStoreOrder(orderId: string): Promise<boolean> {
  const order = await prisma.storeOrder.findUnique({ where: { id: orderId } });
  if (!order || order.paymentMethod !== "MANUAL") return false;
  if (order.status !== "PENDIENTE" && order.status !== "EN_REVISION") return false;
  const companyId = order.companyId;
  const meta = receiptMetaOf(order);
  const codes = [meta?.securityCode, meta?.operationNumber]
    .map((c) => String(c ?? "").replace(/\D/g, ""))
    .filter((c) => c.length >= 3);
  const payerName = (order.payerName ?? "").trim();

  let top: { id: string; matchScore: number; matchReasons: string[] } | undefined;
  try {
    const candidates = (await matchPayments(companyId, {
      payerName: payerName || undefined,
      amountPaid: Number(order.amount),
      operationCodes: codes,
      limit: 5,
    } as Parameters<typeof matchPayments>[1])) as unknown as { id: string; matchScore: number; matchReasons: string[] }[];
    top = candidates[0];
  } catch (err) {
    console.warn(`[storefront] matching falló order=${order.id}:`, err instanceof Error ? err.message : err);
    return false;
  }
  const reasons = top?.matchReasons ?? [];
  const codeMatched = reasons.includes("operation_code_exact");
  const nameMatched = reasons.includes("payer_name_exact") || reasons.includes("payer_name_similar");
  if (!top || !(codeMatched || nameMatched)) return false;

  try {
    await claimPayment(companyId, top.id, { claimedBy: "storefront", claimTtlSeconds: 120 });
    // Sin customerPhone: el comprador web tiene teléfono sintético `web:` y el
    // normalizador crearía otro cliente. El vínculo se fija abajo.
    await updatePaymentStatus(companyId, top.id, {
      status: "APROBADO",
      validationMode: "AUTO",
      matchScore: Math.min(100, Math.max(0, Math.round(top.matchScore))),
      matchStrategy: reasons.join("+") || "storefront_auto",
      matchedPayerNameInput: payerName || codes[0] || "",
      productIds: orderProductIds(order),
      note: "Pago Yape/Plin validado automáticamente desde la tienda web",
      metadata: { channel: "storefront", storeOrderId: order.id, email: order.email },
    });
    await prisma.paymentReceipt.update({
      where: { id: top.id },
      data: { customerId: order.customerId, ...(order.receiptMediaUrl ? { mediaUrl: order.receiptMediaUrl } : {}) },
    });
  } catch (err) {
    // Otro proceso (el agente del chat, el dueño) lo tomó o aprobó: no es nuestro.
    console.warn(`[storefront] no se pudo aprobar receipt=${top.id} order=${order.id}:`, err instanceof Error ? err.message : err);
    return false;
  }

  await fulfillStoreOrder(order, top.id, {
    paid: Number(order.amount),
    payerName: payerName || order.name,
    providerLabel: "Yape/Plin (tienda web)",
  });
  return true;
}

/**
 * Comprobante subido por el comprador: lo lee con visión (si el tenant tiene IA),
 * intenta el matching y, si no aprueba, deja el pedido EN_REVISION (el worker
 * reintenta y luego avisa al dueño).
 */
export async function submitStoreReceipt(
  orderId: string,
  input: { mediaUrl: string; payerName?: string | null },
) {
  const order = await prisma.storeOrder.findUnique({ where: { id: orderId } });
  if (!order) throw new AppError("Pedido no encontrado", 404);
  if (order.paymentMethod !== "MANUAL") throw new AppError("Este pedido se paga con Mercado Pago", 409);
  if (order.status === "PAGADO" || order.status === "ENTREGADO") {
    return { status: order.status, mensaje: "Tu pago ya está confirmado ✅" };
  }
  if (order.status === "FALLIDO") throw new AppError("Este pedido ya fue cerrado. Escríbenos por WhatsApp.", 409);
  const companyId = order.companyId;

  // 1) Visión (best-effort; requiere la key de IA del tenant).
  let meta: StoreReceiptMeta = { amountText: null, operationNumber: null, securityCode: null, isReceipt: null, description: null };
  try {
    const config = (await buildBotConfig(companyId)) as { openai?: AiSettings };
    const ai = config.openai;
    if (ai?.apiKey) {
      const r = await readReceiptImage(ai, input.mediaUrl);
      if (r) meta = { amountText: r.amountText, operationNumber: r.operationNumber, securityCode: r.securityCode, isReceipt: r.isReceipt, description: r.description };
    }
  } catch (err) {
    console.warn(`[storefront] visión falló order=${order.id}:`, err instanceof Error ? err.message : err);
  }
  if (meta.isReceipt === false && !meta.amountText && !meta.securityCode && !meta.operationNumber) {
    throw new AppError("La imagen no parece un comprobante de pago. Sube la captura de la constancia de Yape/Plin.", 400);
  }

  const payerName = (input.payerName ?? "").trim().slice(0, 120) || order.payerName || null;
  await prisma.storeOrder.update({
    where: { id: order.id },
    data: {
      receiptMediaUrl: input.mediaUrl,
      payerName,
      recheckAttempts: 0,
      status: "PENDIENTE",
      metadata: { ...((order.metadata as object) ?? {}), receipt: meta, receiptUploadedAt: new Date().toISOString() },
    },
  });

  // 2) Matching inmediato.
  const approved = await tryMatchStoreOrder(order.id);
  if (approved) {
    const fresh = await prisma.storeOrder.findUnique({ where: { id: order.id }, select: { status: true } });
    return { status: fresh?.status ?? "PAGADO", mensaje: "¡Pago confirmado! ✅ Te enviamos el acceso a tu correo." };
  }

  // 3) Sin match: EN_REVISION; el worker reintenta y luego avisa al dueño.
  await prisma.storeOrder.update({ where: { id: order.id }, data: { status: "EN_REVISION" } });
  socketService.emitToCompany(companyId, SOCKET_EVENTS.RECEIPT_NEW, { storeOrderId: order.id, source: "storefront" });
  return {
    status: "EN_REVISION" as StoreOrderStatus,
    mensaje: "Recibimos tu comprobante. Lo validamos en unos minutos y te enviamos el acceso a tu correo.",
  };
}

/** Worker: reintenta el matching de pedidos EN_REVISION y avisa al dueño al agotar los intentos. */
export async function recheckStoreOrdersInReview(): Promise<void> {
  const cutoff = new Date(Date.now() - 55_000);
  const rows = await prisma.storeOrder.findMany({
    where: { status: "EN_REVISION", paymentMethod: "MANUAL", recheckAttempts: { lt: STORE_RECHECK_MAX }, updatedAt: { lte: cutoff } },
    select: { id: true, companyId: true },
    orderBy: { updatedAt: "asc" },
    take: 50,
  });
  for (const row of rows) {
    const approved = await tryMatchStoreOrder(row.id).catch(() => false);
    if (approved) continue;
    const updated = await prisma.storeOrder.update({
      where: { id: row.id },
      data: { recheckAttempts: { increment: 1 } },
    });
    if (updated.recheckAttempts >= STORE_RECHECK_MAX) await notifyOwnerOrderInReview(updated).catch(() => undefined);
  }
}

async function notifyOwnerOrderInReview(order: StoreOrderRow) {
  const companyId = order.companyId;
  const amountText = `${symbolFor(order.currency)} ${Number(order.amount).toFixed(2)}`;
  const panel = `${(env.FRONTEND_URL || "").replace(/\/$/, "")}/tienda-web`;
  const text =
    `🧾 Pedido de tu tienda web pendiente de revisión: *${order.productName}* · ${amountText} · ${order.name} (${order.email})` +
    (order.payerName ? ` · pagó: ${order.payerName}` : "") +
    `. No encontré el pago automáticamente. Revisa el comprobante y apruébalo en el panel: ${panel}`;
  await notifyOwner(companyId, text);
  if (order.receiptMediaUrl) {
    const pay = await prisma.paymentConfig.findUnique({ where: { companyId }, select: { notificationPhone: true } });
    const to = (pay?.notificationPhone ?? "").replace(/\D/g, "");
    const sender = to ? await loadWhatsappSender(companyId) : null;
    if (sender && to) await sendMedia(sender, to, "image", order.receiptMediaUrl, "Comprobante subido por el comprador").catch(() => undefined);
  }
  await prisma.storeOrder.update({
    where: { id: order.id },
    data: { metadata: { ...((order.metadata as object) ?? {}), ownerNotifiedAt: new Date().toISOString() } },
  });
}

/** Panel: el dueño aprueba un pedido Yape/Plin (crea el comprobante APROBADO manual y entrega). */
export async function approveStoreOrder(companyId: string, orderId: string, input: { note?: string | null }) {
  const order = await prisma.storeOrder.findFirst({ where: { id: orderId, companyId } });
  if (!order) throw new AppError("Pedido no encontrado", 404);
  if (order.paymentMethod !== "MANUAL") throw new AppError("Este pedido se cobra por Mercado Pago; se confirma solo", 409);
  if (order.status === "PAGADO" || order.status === "ENTREGADO") throw new AppError("El pedido ya está pagado", 409);
  if (order.status === "FALLIDO") throw new AppError("El pedido está cerrado como fallido", 409);
  const paid = Number(order.amount);
  const receipt = await prisma.paymentReceipt.create({
    data: {
      companyId,
      customerId: order.customerId,
      productId: order.productId,
      productIds: orderProductIds(order),
      amountExpected: String(paid),
      amountPaid: String(paid),
      currency: order.currency,
      status: "APROBADO",
      source: "manual",
      payerName: order.payerName || order.name,
      paymentSource: "yape_plin",
      mediaUrl: order.receiptMediaUrl,
      occurredAt: new Date(),
      validatedAt: new Date(),
      validationMode: "MANUAL",
      validationNote: input.note?.trim() || "Pago Yape/Plin de la tienda web aprobado por el negocio",
      metadata: { channel: "storefront", storeOrderId: order.id, email: order.email },
    },
  });
  socketService.emitToCompany(companyId, SOCKET_EVENTS.RECEIPT_NEW, { receiptId: receipt.id, source: "manual" });
  await fulfillStoreOrder(order, receipt.id, { paid, payerName: order.payerName || order.name, providerLabel: "Yape/Plin (tienda web, aprobado por ti)" });
  const fresh = await prisma.storeOrder.findUnique({ where: { id: order.id } });
  return serializeOrderRow(fresh!);
}

/** Panel: el dueño rechaza un pedido Yape/Plin (FALLIDO con motivo). */
export async function rejectStoreOrder(companyId: string, orderId: string, input: { reason?: string | null }) {
  const order = await prisma.storeOrder.findFirst({ where: { id: orderId, companyId } });
  if (!order) throw new AppError("Pedido no encontrado", 404);
  if (order.status === "PAGADO" || order.status === "ENTREGADO") throw new AppError("El pedido ya está pagado; no se puede rechazar", 409);
  const fresh = await prisma.storeOrder.update({
    where: { id: order.id },
    data: { status: "FALLIDO", failureReason: `Rechazado: ${input.reason?.trim() || "comprobante no válido"}` },
  });
  return serializeOrderRow(fresh);
}

// ---------------------------------------------------------------------------
// Panel del tenant
// ---------------------------------------------------------------------------

export async function getStorefrontConfig(companyId: string) {
  const cfg =
    (await prisma.storefrontConfig.findUnique({ where: { companyId } })) ??
    (await prisma.storefrontConfig.create({ data: { companyId } }));
  return { ...cfg, status: await storefrontStatus(companyId, cfg.enabled) };
}

export async function updateStorefrontConfig(
  companyId: string,
  data: {
    enabled?: boolean;
    title?: string | null;
    tagline?: string | null;
    accentColor?: string | null;
    logoUrl?: string | null;
    whatsappNumber?: string | null;
    productIds?: string[];
    manualPaymentsEnabled?: boolean;
  },
) {
  if (data.logoUrl) {
    const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
    if (!data.logoUrl.startsWith(`${base}/uploads/`)) throw new AppError("El logo debe ser un archivo subido a FlowApp", 400);
  }
  if (data.enabled === true) {
    const st = await storefrontStatus(companyId, true);
    if (!st.slugValido) throw new AppError(`No se puede activar: ${st.slugProblema}`, 409);
  }
  const cfg = await prisma.storefrontConfig.upsert({
    where: { companyId },
    update: {
      ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      ...(data.title !== undefined ? { title: data.title?.trim() || null } : {}),
      ...(data.tagline !== undefined ? { tagline: data.tagline?.trim() || null } : {}),
      ...(data.accentColor !== undefined ? { accentColor: data.accentColor || null } : {}),
      ...(data.logoUrl !== undefined ? { logoUrl: data.logoUrl || null } : {}),
      ...(data.whatsappNumber !== undefined ? { whatsappNumber: data.whatsappNumber?.replace(/\D/g, "") || null } : {}),
      ...(data.productIds !== undefined ? { productIds: data.productIds } : {}),
      ...(data.manualPaymentsEnabled !== undefined ? { manualPaymentsEnabled: data.manualPaymentsEnabled } : {}),
    },
    create: {
      companyId,
      enabled: data.enabled ?? false,
      title: data.title?.trim() || null,
      tagline: data.tagline?.trim() || null,
      accentColor: data.accentColor || null,
      logoUrl: data.logoUrl || null,
      whatsappNumber: data.whatsappNumber?.replace(/\D/g, "") || null,
      productIds: data.productIds ?? [],
      manualPaymentsEnabled: data.manualPaymentsEnabled ?? true,
    },
  });
  tlsAskCache.clear();
  return { ...cfg, status: await storefrontStatus(companyId, cfg.enabled) };
}

/** Checklist de requisitos de la tienda (para el panel y el copiloto). */
export async function storefrontStatus(companyId: string, enabled: boolean) {
  const [company, pc, ent, cfg] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { slug: true } }),
    prisma.paymentConfig.findUnique({
      where: { companyId },
      select: { enabled: true, mpEnabled: true, mpAccessToken: true, mpStoreEnabled: true, methods: { select: { method: true } } },
    }),
    getEntitlements(companyId),
    prisma.storefrontConfig.findUnique({ where: { companyId }, select: { productIds: true, manualPaymentsEnabled: true } }),
  ]);
  const slug = company?.slug ?? "";
  const slugProblema = storeSlugProblem(slug);
  const eligible = await eligibleProducts(companyId, cfg?.productIds ?? []);
  const sinCorreo = await prisma.product.findMany({
    where: {
      companyId,
      active: true,
      showInCatalog: true,
      productType: "DIGITAL",
      OR: [{ digitalDelivery: null }, { digitalDelivery: { is: { OR: [{ emailEnabled: false }, { assignmentMode: { not: "STATIC" } }] } } }],
    },
    select: { id: true, name: true },
  });
  const moduloTienda = ent.legacy || ent.modules.includes("STOREFRONT");
  const moduloMp = ent.legacy || ent.modules.includes("MERCADOPAGO");
  const mpConectado = Boolean(pc?.mpEnabled && pc.mpAccessToken);
  const mpTiendaHabilitado = Boolean(pc?.mpStoreEnabled ?? true);
  const mpConfigurado = moduloMp && mpConectado && mpTiendaHabilitado;
  // Yape/Plin: métodos manuales de Pagos + opción de la tienda (default activa).
  const metodosManuales = pc?.enabled ? (pc.methods ?? []).map((m) => m.method) : [];
  const manualHabilitado = cfg?.manualPaymentsEnabled ?? true;
  const pagosManuales = manualHabilitado && metodosManuales.length > 0;
  const pagosListos = mpConfigurado || pagosManuales;
  return {
    url: slugProblema ? null : storeUrl(slug),
    slug,
    slugValido: !slugProblema,
    slugProblema,
    subdominios: Boolean(env.STORE_DOMAIN),
    moduloTienda,
    moduloMp,
    mpConfigurado,
    mpConectado,
    mpTiendaHabilitado,
    pagosManuales,
    manualHabilitado,
    metodosManuales,
    pagosListos,
    productosElegibles: eligible.map((p) => ({ id: p.id, name: p.name })),
    productosSinCorreo: sinCorreo,
    lista: enabled && !slugProblema && moduloTienda && pagosListos && eligible.length > 0,
  };
}

const ORDER_ROW_SELECT = {
  id: true,
  productId: true,
  productName: true,
  items: true,
  productIds: true,
  name: true,
  email: true,
  phone: true,
  amount: true,
  currency: true,
  status: true,
  paymentMethod: true,
  receiptMediaUrl: true,
  payerName: true,
  recheckAttempts: true,
  receiptId: true,
  deliveredAt: true,
  failureReason: true,
  createdAt: true,
  customerId: true,
  metadata: true,
} satisfies Prisma.StoreOrderSelect;

type OrderRowSel = Prisma.StoreOrderGetPayload<{ select: typeof ORDER_ROW_SELECT }>;

function serializeOrderRow(o: OrderRowSel) {
  const md = (o.metadata ?? {}) as Record<string, unknown>;
  const r = (md.receipt ?? null) as StoreReceiptMeta | null;
  return {
    id: o.id,
    productId: o.productId,
    productName: o.productName,
    items: (Array.isArray(o.items) ? (o.items as unknown as StoreOrderItem[]) : null) ?? [],
    productIds: orderProductIds(o),
    name: o.name,
    email: o.email,
    phone: o.phone,
    amount: Number(o.amount),
    amountText: `${symbolFor(o.currency)} ${Number(o.amount).toFixed(2)}`,
    currency: o.currency,
    status: o.status,
    paymentMethod: o.paymentMethod,
    receiptMediaUrl: o.receiptMediaUrl,
    payerName: o.payerName,
    recheckAttempts: o.recheckAttempts,
    receiptId: o.receiptId,
    deliveredAt: o.deliveredAt,
    failureReason: o.failureReason,
    createdAt: o.createdAt,
    customerId: o.customerId,
    // Lo que la visión leyó del comprobante (ayuda al dueño a revisar).
    comprobante: r ? { montoLeido: r.amountText, operacion: r.operationNumber, codigo: r.securityCode } : null,
  };
}

export async function listStoreOrders(companyId: string, page = 1, limit = 25, status?: StoreOrderStatus) {
  const where: Prisma.StoreOrderWhereInput = { companyId, ...(status ? { status } : {}) };
  const [items, total, enRevision] = await Promise.all([
    prisma.storeOrder.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: ORDER_ROW_SELECT,
    }),
    prisma.storeOrder.count({ where }),
    prisma.storeOrder.count({ where: { companyId, status: "EN_REVISION" } }),
  ]);
  return { items: items.map(serializeOrderRow), total, page, limit, enRevision };
}
