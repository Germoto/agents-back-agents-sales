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
import { reportStorePurchase, storePixelId, type StoreWebClient } from "../meta-capi/meta-capi.service";
import { signDownloadToken } from "../../lib/jwt";

// ---------------------------------------------------------------------------
// Portada: tipos de la configuración (JSON) y valores por defecto
// ---------------------------------------------------------------------------

export type HeroSlide = { productId: string; kicker: string; headline: string; sub: string; imageUrl: string | null; bg: string | null };
export type TrustItem = { title: string; sub: string };
export type StoreFaq = { question: string; answer: string };

export type StoreMediaType = "IMAGE" | "VIDEO" | "PDF" | "OTHER";
export type StoreMediaItem = { url: string; type: StoreMediaType; title?: string | null };
export type ProductOverride = {
  imageUrl?: string | null;
  /** Compatibilidad: una sola categoría (se lee como [category]). */
  category?: string | null;
  /** Varias categorías tipo etiquetas (hasta 6). */
  categories?: string[] | null;
  shortDescription?: string | null;
  sortOrder?: number | null;
  /** Recursos de muestra en la ficha (PDF, video, imágenes); opt-in. */
  media?: StoreMediaItem[] | null;
};
export type ProductOverrides = Record<string, ProductOverride>;

const MEDIA_TYPES: StoreMediaType[] = ["IMAGE", "VIDEO", "PDF", "OTHER"];

/** Categorías efectivas de un producto en la tienda: override (lista o única) o la del producto. */
function categoriesOf(ov: ProductOverride | undefined, productCategory: string | null | undefined): string[] {
  const raw = ov?.categories?.length ? ov.categories : ov?.category ? [ov.category] : productCategory ? [productCategory] : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of raw) {
    const t = String(c ?? "").trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out.slice(0, 6);
}

function mediaOf(ov: ProductOverride | undefined): StoreMediaItem[] {
  return (ov?.media ?? []).filter((m) => m && typeof m.url === "string" && MEDIA_TYPES.includes(m.type)).slice(0, 12);
}

function overridesOf(cfg: { productOverrides?: unknown }): ProductOverrides {
  const v = cfg.productOverrides;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as ProductOverrides) : {};
}

/** Imagen de portada efectiva en la tienda: override o primera imagen de presentación. */
function storeImageOf(p: { files: { type: string; showInPresentation: boolean; url: string }[] }, ov?: ProductOverride): string | null {
  return ov?.imageUrl || p.files.find((f) => f.type === "IMAGE" && f.showInPresentation)?.url || null;
}

export const DEFAULT_TRUST_ITEMS: TrustItem[] = [
  { title: "Entrega inmediata", sub: "El acceso llega a tu correo al confirmar el pago" },
  { title: "Yape, Plin o tarjeta", sub: "Pago seguro y validación automática" },
  { title: "Soporte por WhatsApp", sub: "Te ayudamos antes y después de comprar" },
];

function jsonArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** -% entre precio de lista (regular) y precio efectivo; null si no hay descuento real. */
function discountPct(price: string | null | undefined, regular: string | null | undefined): number | null {
  const p = parsePrice(price);
  const r = parsePrice(regular);
  if (p <= 0 || r <= p) return null;
  return Math.round((1 - p / r) * 100);
}

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
  const [pay, metaPixelId] = await Promise.all([storePaymentOptions(company.id, cfg, ent), storePixelId(company.id)]);
  const overrides = overridesOf(cfg);
  const mapped = products
    .map((p, idx) => {
      const ov = overrides[p.id];
      const b = mapBotProduct(p, { currencySymbol: symbol, timezone: company.timezone });
      const cover = storeImageOf(p, ov);
      const images = [
        ...(cover ? [{ url: cover, description: "" }] : []),
        ...p.files.filter((f) => f.type === "IMAGE" && f.showInPresentation && f.url !== cover).map((f) => ({ url: f.url, description: f.description || "" })),
      ];
      const categories = categoriesOf(ov, b.category);
      return {
        p,
        b,
        ov,
        images,
        categories,
        category: categories[0] ?? null,
        recursos: mediaOf(ov).map((m) => ({ type: m.type, url: m.url, title: (m.title ?? "").trim() || null })),
        shortDescription: (ov?.shortDescription ?? "").trim() || b.shortDescription,
        order: typeof ov?.sortOrder === "number" ? ov.sortOrder : 1000 + idx,
      };
    })
    .sort((a, b2) => a.order - b2.order);
  const byId = new Map(mapped.map((x) => [x.p.id, x]));
  const slides = jsonArray<HeroSlide>(cfg.heroSlides)
    .filter((sl) => sl && typeof sl.productId === "string" && byId.has(sl.productId))
    .slice(0, 5)
    .map((sl) => {
      const { p, b, images, shortDescription } = byId.get(sl.productId)!;
      return {
        productId: p.id,
        productSlug: b.slug,
        kicker: (sl.kicker ?? "").trim(),
        headline: (sl.headline ?? "").trim() || p.name,
        sub: (sl.sub ?? "").trim() || shortDescription,
        imageUrl: sl.imageUrl || images[0]?.url || null,
        bg: sl.bg || null,
        priceText: b.priceText ?? b.price,
        regularPriceText: b.regularPriceText,
        discountPct: discountPct(b.price, b.regularPrice),
      };
    });
  const categorias = Array.from(new Set(mapped.flatMap((x) => x.categories)));
  return {
    pagos: { mercadoPago: pay.mercadoPago, manual: pay.manual },
    portada: { slides, autoplay: cfg.carouselAutoplay, intervalSec: cfg.carouselIntervalSec },
    confianza: jsonArray<TrustItem>(cfg.trustItems).length ? jsonArray<TrustItem>(cfg.trustItems).slice(0, 3) : DEFAULT_TRUST_ITEMS,
    faqs: jsonArray<StoreFaq>(cfg.faqs).slice(0, 10),
    mostrarPrecioAnterior: cfg.showOldPrice,
    footerTagline: cfg.footerTagline || cfg.tagline || null,
    categorias,
    negocio: {
      metaPixelId,
      slug: company.slug,
      name: company.name,
      title: cfg.title || company.name,
      tagline: cfg.tagline || null,
      accentColor: cfg.accentColor || null,
      logoUrl: cfg.logoUrl || null,
      currency: company.currency,
      whatsappNumber: cfg.whatsappNumber ? cfg.whatsappNumber.replace(/\D/g, "") || null : null,
    },
    productos: mapped.map(({ p, b, images, category, categories, recursos, shortDescription }) => {
      return {
        id: b.id,
        slug: b.slug,
        name: b.name,
        price: b.price,
        priceText: b.priceText,
        regularPrice: b.regularPrice ?? null,
        regularPriceText: b.regularPriceText,
        discountPct: discountPct(b.price, b.regularPrice),
        offerActive: b.offerActive,
        offerEndsText: b.offerEndsText,
        // Para la cuenta regresiva en la tienda (null si no hay oferta vigente con fin).
        offerEndsAt: b.offerEndsAt ? b.offerEndsAt.toISOString() : null,
        shortDescription,
        fullDescription: b.fullDescription,
        category,
        categories,
        recursos,
        benefits: b.benefits,
        includes: b.includes,
        bonuses: b.bonuses,
        faqs: b.faqs.map((f) => ({ question: f.question, answer: f.answer })),
        // Solo imágenes de presentación (nunca los archivos de entrega); la portada de la tienda primero.
        images,
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
  const firstSlide = jsonArray<HeroSlide>(cfg.heroSlides)[0];
  let image = firstSlide?.imageUrl || cfg.logoUrl || "";
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
      const img = storeImageOf(product, overridesOf(cfg)[product.id]);
      if (img) image = img;
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
  input: { productId?: string; productIds?: string[]; name: string; email: string; phone?: string | null; method?: StoreCheckoutMethod; coupon?: string | null },
  client?: StoreWebClient | null,
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
  const subtotal = Number(items.reduce((acc, it) => acc + it.unitPrice * it.qty, 0).toFixed(2));
  const productName = items.length > 1 ? `${product.name} +${items.length - 1} más` : product.name;
  // Cupón: descuento sobre el precio de lista; se reparte proporcionalmente en los ítems
  // (Mercado Pago no acepta ítems negativos) y se cuenta el uso recién al pagar.
  const coupon = input.coupon?.trim() ? await validateCoupon(companyId, input.coupon, items.map((it) => it.productId), subtotal) : null;
  if (coupon && coupon.discount > 0) {
    const factor = (subtotal - coupon.discount) / subtotal;
    let acc = 0;
    items.forEach((it, i) => {
      if (i < items.length - 1) {
        it.unitPrice = Number((it.unitPrice * factor).toFixed(2));
        acc += it.unitPrice;
      } else {
        it.unitPrice = Number((subtotal - coupon.discount - acc).toFixed(2));
      }
    });
  }
  const priceNum = Number(items.reduce((acc, it) => acc + it.unitPrice * it.qty, 0).toFixed(2));
  if (priceNum <= 0) throw new AppError("El total del pedido debe ser mayor a 0", 409);
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
      metadata: {
        listPrice: subtotal,
        feeMode: pc?.mpFeeMode ?? null,
        ...(coupon ? { coupon: { couponId: coupon.couponId, code: coupon.code, discount: coupon.discount } } : {}),
        ...(client ? { web: client } : {}),
      },
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
      descuento: coupon ? { code: coupon.code, amount: coupon.discount } : null,
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
    descuento: coupon ? { code: coupon.code, amount: coupon.discount } : null,
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
  const paidOk = order.status === "PAGADO" || order.status === "ENTREGADO";
  const archivos = order.status === "ENTREGADO" ? await deliveryFileLinks(order.companyId, orderProductIds(order), `order:${order.id}`) : [];
  const upsell = paidOk
    ? await prisma.storefrontConfig
        .findUnique({ where: { companyId: order.companyId }, select: { productIds: true } })
        .then((c) => upsellFor(order.companyId, orderProductIds(order), c?.productIds ?? []))
        .catch(() => null)
    : null;
  return {
    id: order.id,
    status: order.status,
    paymentMethod: order.paymentMethod,
    productName: order.productName,
    upsell,
    archivos,
    productos: items.length ? items.map((it) => it.name) : [order.productName],
    productIds: orderProductIds(order),
    amount: Number(order.amount),
    currency: order.currency,
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

  void recordPurchaseEvent(order);
  void consumeCoupon(order);

  // Meta CAPI (Purchase de la tienda web). Best-effort, dedupe con el píxel por event_id.
  void reportStorePurchase({
    companyId,
    receiptId,
    orderId: order.id,
    email: order.email,
    phone: order.phone && !order.phone.startsWith("web:") ? order.phone : null,
    customerId: order.customerId,
    productIds: orderProductIds(order),
    client: ((order.metadata ?? {}) as { web?: StoreWebClient }).web ?? null,
  }).catch(() => undefined);

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
  const panel = `${(env.FRONTEND_URL || "").replace(/\/$/, "")}/tienda-web?tab=pedidos`;
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
// Archivos de entrega (enlaces firmados para los privados)
// ---------------------------------------------------------------------------

/** URL de descarga de un archivo: firmada (7 días) si es privado; pública si no. */
export function fileDownloadUrl(file: { id: string; url: string; privateDownload: boolean }, companyId: string, ref: string): string {
  if (!file.privateDownload) return file.url;
  return `${file.url}?t=${encodeURIComponent(signDownloadToken({ companyId, fileId: file.id, ref }))}`;
}

/** Archivos de entrega de los productos comprados (privados + marcados para correo), con enlace listo. */
export async function deliveryFileLinks(companyId: string, productIds: string[], ref: string) {
  const products = await prisma.product.findMany({
    where: { companyId, id: { in: productIds } },
    select: { id: true, name: true, files: { where: { OR: [{ privateDownload: true }, { sendByEmail: true }] }, orderBy: { sortOrder: "asc" } } },
  });
  return products.flatMap((p) =>
    p.files.map((f) => ({
      productName: p.name,
      name: f.originalName || f.description || `archivo.${f.extension || "bin"}`,
      url: fileDownloadUrl(f, companyId, ref),
      privado: f.privateDownload,
    })),
  );
}

// ---------------------------------------------------------------------------
// Analítica ligera (StoreEvent) y upsell post-compra
// ---------------------------------------------------------------------------

export const STORE_EVENT_TYPES = ["VIEW", "PRODUCT_VIEW", "ADD_TO_CART", "CHECKOUT", "WA_CLICK", "PURCHASE", "DOWNLOAD", "RESOURCE_VIEW"] as const;
export type StoreEventType = (typeof STORE_EVENT_TYPES)[number];
const STORE_EVENT_RETENTION_DAYS = 180;

/** Eventos enviados por el navegador (lote). Ignora tipos desconocidos; PURCHASE solo lo escribe el backend. */
export async function recordStoreEvents(slug: string, sessionId: string, events: { type: string; productId?: string | null }[]) {
  const { company } = await resolveStore(slug);
  const sid = sessionId.trim().slice(0, 64);
  if (!sid) return { ok: true, saved: 0 };
  const rows = events
    .filter((e) => (STORE_EVENT_TYPES as readonly string[]).includes(e.type) && e.type !== "PURCHASE" && e.type !== "DOWNLOAD")
    .slice(0, 20)
    .map((e) => ({ companyId: company.id, type: e.type, productId: e.productId || null, sessionId: sid }));
  if (rows.length) await prisma.storeEvent.createMany({ data: rows });
  return { ok: true, saved: rows.length };
}

async function recordPurchaseEvent(order: StoreOrderRow) {
  const web = ((order.metadata ?? {}) as { web?: { sessionId?: string | null } }).web;
  const sessionId = web?.sessionId || `order:${order.id}`;
  await prisma.storeEvent
    .createMany({
      data: orderProductIds(order).map((productId) => ({ companyId: order.companyId, type: "PURCHASE", productId, orderId: order.id, sessionId })),
    })
    .catch(() => undefined);
}

/** Purga eventos antiguos (worker, una vez al día). */
export async function purgeOldStoreEvents(): Promise<number> {
  const r = await prisma.storeEvent.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - STORE_EVENT_RETENTION_DAYS * 86_400_000) } } });
  return r.count;
}

/** KPIs de la tienda en los últimos N días (panel + copiloto). */
export async function storeMetrics(companyId: string, days = 30) {
  const since = new Date(Date.now() - days * 86_400_000);
  const events = await prisma.storeEvent.findMany({
    where: { companyId, createdAt: { gte: since } },
    select: { type: true, productId: true, sessionId: true },
  });
  const sessions = new Set<string>();
  const count: Record<StoreEventType, number> = { VIEW: 0, PRODUCT_VIEW: 0, ADD_TO_CART: 0, CHECKOUT: 0, WA_CLICK: 0, PURCHASE: 0, DOWNLOAD: 0, RESOURCE_VIEW: 0 };
  const buyers = new Set<string>();
  const byProduct = new Map<string, { vistas: number; carrito: number; checkouts: number; compras: number; whatsapp: number; muestras: number }>();
  for (const e of events) {
    sessions.add(e.sessionId);
    const t = e.type as StoreEventType;
    if (t in count) count[t] += 1;
    if (t === "PURCHASE") buyers.add(e.sessionId);
    if (e.productId) {
      let p = byProduct.get(e.productId);
      if (!p) {
        p = { vistas: 0, carrito: 0, checkouts: 0, compras: 0, whatsapp: 0, muestras: 0 };
        byProduct.set(e.productId, p);
      }
      if (t === "PRODUCT_VIEW") p.vistas += 1;
      else if (t === "ADD_TO_CART") p.carrito += 1;
      else if (t === "CHECKOUT") p.checkouts += 1;
      else if (t === "PURCHASE") p.compras += 1;
      else if (t === "WA_CLICK") p.whatsapp += 1;
      else if (t === "RESOURCE_VIEW") p.muestras += 1;
    }
  }
  const [orders, pending, names] = await Promise.all([
    prisma.storeOrder.findMany({
      where: { companyId, status: "ENTREGADO", createdAt: { gte: since } },
      select: { amount: true, currency: true },
    }),
    prisma.storeOrder.findMany({
      where: { companyId, status: { in: ["PENDIENTE", "EN_REVISION"] }, createdAt: { gte: since } },
      select: { amount: true, currency: true },
    }),
    byProduct.size
      ? prisma.product.findMany({ where: { companyId, id: { in: [...byProduct.keys()] } }, select: { id: true, name: true } })
      : Promise.resolve([] as { id: string; name: string }[]),
  ]);
  const nameOf = new Map(names.map((n) => [n.id, n.name]));
  const ingresos = orders.reduce((acc, o) => acc + Number(o.amount), 0);
  const currency = orders[0]?.currency ?? pending[0]?.currency ?? "PEN";
  const pendMonto = pending.reduce((acc, o) => acc + Number(o.amount), 0);
  const visitas = sessions.size;
  return {
    dias: days,
    visitas,
    vistasProducto: count.PRODUCT_VIEW,
    agregadosAlCarrito: count.ADD_TO_CART,
    checkouts: count.CHECKOUT,
    clicsWhatsApp: count.WA_CLICK,
    compras: orders.length,
    descargas: count.DOWNLOAD,
    ingresos: Number(ingresos.toFixed(2)),
    ingresosText: `${symbolFor(currency)} ${ingresos.toFixed(2)}`,
    pendientes: { pedidos: pending.length, monto: Number(pendMonto.toFixed(2)), montoText: `${symbolFor(currency)} ${pendMonto.toFixed(2)}` },
    conversion: visitas > 0 ? Number(((buyers.size / visitas) * 100).toFixed(1)) : null,
    porProducto: [...byProduct.entries()]
      .map(([productId, m]) => ({ productId, name: nameOf.get(productId) ?? "(producto eliminado)", ...m }))
      .sort((a, b) => b.compras - a.compras || b.vistas - a.vistas)
      .slice(0, 20),
  };
}

/** Producto relacionado (cross-sell del producto comprado) si está visible en la tienda. */
async function upsellFor(companyId: string, productIds: string[], cfgProductIds: string[]) {
  const [company, bought] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { currency: true, timezone: true } }),
    prisma.product.findMany({ where: { companyId, id: { in: productIds } }, select: { id: true, digitalDelivery: { select: { crossSellProductId: true, crossSellPitch: true, crossSellPitchMediaUrl: true, crossSellPitchMediaType: true } } } }),
  ]);
  if (!company) return null;
  for (const b of bought) {
    const crossId = b.digitalDelivery?.crossSellProductId;
    if (!crossId || productIds.includes(crossId)) continue;
    const [cross] = await eligibleProducts(companyId, cfgProductIds).then((rows) => rows.filter((p) => p.id === crossId));
    if (!cross) continue;
    const bot = mapBotProduct(cross, { currencySymbol: symbolFor(company.currency), timezone: company.timezone });
    const ovCfg = await prisma.storefrontConfig.findUnique({ where: { companyId }, select: { productOverrides: true } });
    const img = storeImageOf(cross, overridesOf(ovCfg ?? {})[cross.id]);
    const pitchMedia = (b.digitalDelivery?.crossSellPitchMediaUrl ?? "").trim();
    const pitchIsImage = pitchMedia && (b.digitalDelivery?.crossSellPitchMediaType ?? "").toLowerCase().includes("image");
    return {
      id: cross.id,
      slug: cross.slug,
      name: cross.name,
      priceText: bot.priceText ?? bot.price,
      regularPriceText: bot.regularPriceText,
      shortDescription: bot.shortDescription,
      image: pitchIsImage ? pitchMedia : img,
      pitch: (b.digitalDelivery?.crossSellPitch ?? "").trim() || null,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cupones de descuento
// ---------------------------------------------------------------------------

export function normalizeCouponCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, "").slice(0, 30);
}

type CouponResult = { couponId: string; code: string; type: string; value: number; discount: number };

/** Valida un cupón para unos productos y un subtotal. Lanza 400 con el motivo si no aplica. */
export async function validateCoupon(companyId: string, codeRaw: string, productIds: string[], subtotal: number): Promise<CouponResult> {
  const code = normalizeCouponCode(codeRaw);
  if (!code) throw new AppError("Escribe el código del cupón", 400);
  const c = await prisma.coupon.findUnique({ where: { companyId_code: { companyId, code } } });
  if (!c || !c.active) throw new AppError("Ese cupón no existe o ya no está activo", 400);
  if (c.expiresAt && c.expiresAt.getTime() < Date.now()) throw new AppError("Ese cupón ya venció", 400);
  if (c.maxUses !== null && c.uses >= c.maxUses) throw new AppError("Ese cupón ya alcanzó su límite de usos", 400);
  if (c.productIds.length && !productIds.some((id) => c.productIds.includes(id))) {
    throw new AppError("Ese cupón no aplica a los productos elegidos", 400);
  }
  const value = Number(c.value);
  const discount = c.type === "FIXED" ? Math.min(value, subtotal) : Math.min(subtotal, (subtotal * value) / 100);
  return { couponId: c.id, code: c.code, type: c.type, value, discount: Number(discount.toFixed(2)) };
}

/** Público: previsualiza el descuento de un cupón para el carrito actual. */
export async function previewCoupon(slug: string, code: string, productIds: string[]) {
  const { company, cfg } = await resolveStore(slug);
  const eligible = await eligibleProducts(company.id, cfg.productIds);
  const chosen = eligible.filter((p) => productIds.includes(p.id));
  if (!chosen.length) throw new AppError("Producto no disponible", 404);
  const symbol = symbolFor(company.currency);
  const subtotal = chosen.reduce((acc, p) => acc + parsePrice(mapBotProduct(p, { currencySymbol: symbol, timezone: company.timezone }).price), 0);
  const r = await validateCoupon(company.id, code, chosen.map((p) => p.id), subtotal);
  const total = Number((subtotal - r.discount).toFixed(2));
  return {
    valid: true,
    code: r.code,
    discount: r.discount,
    discountText: `${symbol} ${r.discount.toFixed(2)}`,
    total,
    totalText: `${symbol} ${total.toFixed(2)}`,
    descripcion: r.type === "PERCENT" ? `${r.value}% de descuento` : `${symbol} ${r.value.toFixed(2)} de descuento`,
  };
}

/** Al pagar: cuenta el uso del cupón una sola vez por pedido. */
async function consumeCoupon(order: StoreOrderRow) {
  const md = (order.metadata ?? {}) as { coupon?: { couponId?: string }; couponCounted?: boolean };
  if (!md.coupon?.couponId || md.couponCounted) return;
  await prisma.coupon.update({ where: { id: md.coupon.couponId }, data: { uses: { increment: 1 } } }).catch(() => undefined);
  await prisma.storeOrder.update({ where: { id: order.id }, data: { metadata: { ...(md as object), couponCounted: true } } }).catch(() => undefined);
}

// Panel: CRUD
function serializeCoupon(c: { id: string; code: string; type: string; value: unknown; productIds: string[]; maxUses: number | null; uses: number; expiresAt: Date | null; active: boolean; createdAt: Date }) {
  return { id: c.id, code: c.code, type: c.type, value: Number(c.value), productIds: c.productIds, maxUses: c.maxUses, uses: c.uses, expiresAt: c.expiresAt, active: c.active, createdAt: c.createdAt };
}

export async function listCoupons(companyId: string) {
  const rows = await prisma.coupon.findMany({ where: { companyId }, orderBy: { createdAt: "desc" } });
  return rows.map(serializeCoupon);
}

export async function createCoupon(
  companyId: string,
  data: { code: string; type: "PERCENT" | "FIXED"; value: number; productIds?: string[]; maxUses?: number | null; expiresAt?: string | null; active?: boolean },
) {
  const code = normalizeCouponCode(data.code);
  if (code.length < 3) throw new AppError("El código debe tener al menos 3 caracteres", 400);
  if (data.type === "PERCENT" && (data.value <= 0 || data.value > 100)) throw new AppError("El porcentaje debe estar entre 1 y 100", 400);
  if (data.type === "FIXED" && data.value <= 0) throw new AppError("El monto debe ser mayor a 0", 400);
  try {
    const c = await prisma.coupon.create({
      data: {
        companyId,
        code,
        type: data.type,
        value: new Prisma.Decimal(data.value.toFixed(2)),
        productIds: data.productIds ?? [],
        maxUses: data.maxUses ?? null,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
        active: data.active ?? true,
      },
    });
    return serializeCoupon(c);
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") throw new AppError("Ya existe un cupón con ese código", 409);
    throw err;
  }
}

export async function updateCoupon(
  companyId: string,
  id: string,
  data: { active?: boolean; maxUses?: number | null; expiresAt?: string | null; productIds?: string[] },
) {
  const c = await prisma.coupon.findFirst({ where: { id, companyId } });
  if (!c) throw new AppError("Cupón no encontrado", 404);
  const u = await prisma.coupon.update({
    where: { id },
    data: {
      ...(data.active !== undefined ? { active: data.active } : {}),
      ...(data.maxUses !== undefined ? { maxUses: data.maxUses } : {}),
      ...(data.expiresAt !== undefined ? { expiresAt: data.expiresAt ? new Date(data.expiresAt) : null } : {}),
      ...(data.productIds !== undefined ? { productIds: data.productIds } : {}),
    },
  });
  return serializeCoupon(u);
}

export async function deleteCoupon(companyId: string, id: string) {
  const c = await prisma.coupon.findFirst({ where: { id, companyId } });
  if (!c) throw new AppError("Cupón no encontrado", 404);
  await prisma.coupon.delete({ where: { id } });
  return { ok: true };
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
    heroSlides?: { productId: string; kicker?: string; headline?: string; sub?: string; imageUrl?: string | null; bg?: string | null }[];
    carouselAutoplay?: boolean;
    carouselIntervalSec?: number;
    showOldPrice?: boolean;
    trustItems?: TrustItem[] | null;
    faqs?: StoreFaq[];
    footerTagline?: string | null;
    productOverrides?: Record<string, ProductOverride | null>;
  },
) {
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const isOwnUpload = (u: string) => u.startsWith(`${base}/uploads/`);
  if (data.logoUrl && !isOwnUpload(data.logoUrl)) throw new AppError("El logo debe ser un archivo subido a FlowApp", 400);
  const eligibleRows = data.heroSlides !== undefined || data.productOverrides !== undefined ? await eligibleProducts(companyId, []) : [];
  let productOverrides: ProductOverrides | undefined;
  if (data.productOverrides !== undefined) {
    productOverrides = {};
    for (const [pid, ov] of Object.entries(data.productOverrides)) {
      const prod = eligibleRows.find((p) => p.id === pid);
      if (!prod || !ov) continue;
      const own = prod.files.some((f) => f.url === ov.imageUrl);
      if (ov.imageUrl && !own && !isOwnUpload(ov.imageUrl)) throw new AppError("La portada debe ser un archivo subido a FlowApp", 400);
      const categories = categoriesOf({ categories: ov.categories ?? null, category: ov.category ?? null }, null).map((c) => c.slice(0, 40));
      const media: StoreMediaItem[] = [];
      for (const m of (ov.media ?? []).slice(0, 12)) {
        if (!m || typeof m.url !== "string") continue;
        const url = m.url.trim();
        if (!url) continue;
        if (!isOwnUpload(url) || url.includes("/api/public/dl/")) throw new AppError("Los recursos deben ser archivos públicos subidos a FlowApp", 400);
        media.push({ url, type: MEDIA_TYPES.includes(m.type) ? m.type : "OTHER", title: (m.title ?? "").trim().slice(0, 80) || null });
      }
      const clean: ProductOverride = {
        ...(ov.imageUrl ? { imageUrl: ov.imageUrl } : {}),
        ...(categories.length ? { categories } : {}),
        ...(ov.shortDescription?.trim() ? { shortDescription: ov.shortDescription.trim().slice(0, 160) } : {}),
        ...(typeof ov.sortOrder === "number" && Number.isFinite(ov.sortOrder) ? { sortOrder: Math.round(ov.sortOrder) } : {}),
        ...(media.length ? { media } : {}),
      };
      if (Object.keys(clean).length) productOverrides[pid] = clean;
    }
  }
  let heroSlides: HeroSlide[] | undefined;
  if (data.heroSlides !== undefined) {
    const eligible = new Set(eligibleRows.map((p) => p.id));
    heroSlides = data.heroSlides.slice(0, 5).map((sl) => {
      if (!eligible.has(sl.productId)) throw new AppError("Un slide apunta a un producto que no está listo para la tienda", 400);
      if (sl.imageUrl && !isOwnUpload(sl.imageUrl)) throw new AppError("La imagen del banner debe ser un archivo subido a FlowApp", 400);
      return {
        productId: sl.productId,
        kicker: (sl.kicker ?? "").trim().slice(0, 40),
        headline: (sl.headline ?? "").trim().slice(0, 120),
        sub: (sl.sub ?? "").trim().slice(0, 240),
        imageUrl: sl.imageUrl || null,
        bg: sl.bg && /^#[0-9a-fA-F]{6}$/.test(sl.bg) ? sl.bg : null,
      };
    });
  }
  const trustItems =
    data.trustItems === undefined
      ? undefined
      : data.trustItems === null
        ? null
        : data.trustItems.slice(0, 3).map((t) => ({ title: (t.title ?? "").trim().slice(0, 60), sub: (t.sub ?? "").trim().slice(0, 140) }));
  const faqs = data.faqs === undefined ? undefined : data.faqs.slice(0, 10).map((f) => ({ question: (f.question ?? "").trim().slice(0, 200), answer: (f.answer ?? "").trim().slice(0, 1000) })).filter((f) => f.question && f.answer);
  const extra = {
    ...(heroSlides !== undefined ? { heroSlides: heroSlides as unknown as Prisma.InputJsonValue } : {}),
    ...(data.carouselAutoplay !== undefined ? { carouselAutoplay: data.carouselAutoplay } : {}),
    ...(data.carouselIntervalSec !== undefined ? { carouselIntervalSec: Math.min(12, Math.max(3, Math.round(data.carouselIntervalSec))) } : {}),
    ...(data.showOldPrice !== undefined ? { showOldPrice: data.showOldPrice } : {}),
    ...(trustItems !== undefined ? { trustItems: trustItems === null ? Prisma.DbNull : (trustItems as unknown as Prisma.InputJsonValue) } : {}),
    ...(faqs !== undefined ? { faqs: faqs as unknown as Prisma.InputJsonValue } : {}),
    ...(data.footerTagline !== undefined ? { footerTagline: data.footerTagline?.trim().slice(0, 160) || null } : {}),
    ...(productOverrides !== undefined ? { productOverrides: productOverrides as unknown as Prisma.InputJsonValue } : {}),
  };
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
      ...extra,
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
      ...extra,
    },
  });
  tlsAskCache.clear();
  return { ...cfg, status: await storefrontStatus(companyId, cfg.enabled) };
}

/** Checklist de requisitos de la tienda (para el panel y el copiloto). */
export async function storefrontStatus(companyId: string, enabled: boolean) {
  const [company, pc, ent, cfg] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { slug: true, currency: true, timezone: true } }),
    prisma.paymentConfig.findUnique({
      where: { companyId },
      select: { enabled: true, mpEnabled: true, mpAccessToken: true, mpStoreEnabled: true, methods: { select: { method: true } } },
    }),
    getEntitlements(companyId),
    prisma.storefrontConfig.findUnique({ where: { companyId }, select: { productIds: true, manualPaymentsEnabled: true, productOverrides: true } }),
  ]);
  const overrides = overridesOf(cfg ?? {});
  const slug = company?.slug ?? "";
  const slugProblema = storeSlugProblem(slug);
  // TODOS los elegibles (no filtrados por la selección): la lista del panel debe mostrar
  // también los ocultos para poder volver a activarlos; la visibilidad la decide productIds.
  const eligible = await eligibleProducts(companyId, []);
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
    productosElegibles: eligible
      .map((p, idx) => {
        const b = mapBotProduct(p, { currencySymbol: symbolFor(company?.currency ?? "PEN"), timezone: company?.timezone ?? "America/Lima" });
        const ov = overrides[p.id];
        return {
          id: p.id,
          name: p.name,
          // Valores del PRODUCTO (base) + override de la tienda por separado, para el modal.
          category: b.category ?? null,
          categories: categoriesOf(ov, b.category),
          shortDescription: b.shortDescription,
          priceText: b.priceText ?? b.price,
          regularPriceText: b.regularPriceText,
          imageUrl: storeImageOf(p, ov),
          images: p.files.filter((f) => f.type === "IMAGE" && f.showInPresentation).map((f) => f.url),
          // Archivos públicos del producto (para elegir recursos de muestra); los privados no tienen URL pública.
          files: p.files
            .filter((f) => !f.privateDownload)
            .map((f) => ({ id: f.id, url: f.url, type: f.type, name: f.originalName || f.description || f.url.split("/").pop() || "archivo", description: f.description, showInPresentation: f.showInPresentation })),
          override: ov ?? null,
          order: typeof ov?.sortOrder === "number" ? ov.sortOrder : 1000 + idx,
        };
      })
      .sort((a, b2) => a.order - b2.order)
      .map(({ order: _o, ...rest }) => rest),
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
    cupon: (md.coupon as { code?: string; discount?: number } | undefined)?.code ?? null,
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
