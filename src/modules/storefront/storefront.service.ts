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
import { zonedDayBoundary } from "../dashboard/dashboard.service";
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
import { cancelOrderEmails, emailRemindersOf, sanitizeEmailReminders, scheduleAbandonedCheckout, schedulePostPurchase, type EmailReminders } from "./storefront-email.service";
import {
  announcementOf,
  computeCombo,
  computePhysicalCombo,
  deepMergeJson,
  DEFAULT_GUARANTEE,
  DEFAULT_SAMPLE,
  distributeTotal,
  fillPrice,
  guaranteeOf,
  salesSettingsOf,
  sanitizeAnnouncement,
  sanitizeLanding,
  sanitizeSalesSettings,
  sanitizeVolumePricing,
  videoEmbedUrl,
  volumePricingOf,
  type LandingOverride,
  type PhysicalComboResult,
  type PricedItem,
  type VolumePricing,
} from "./storefront-sales";
import {
  buyerPhoneDigits,
  defaultDialPrefix,
  deliveryBlockedReason,
  DELIVERY_LABELS,
  isSimplePhysicalProduct,
  physicalSettingsOf,
  publicDeliveryOptions,
  resolveVariantChoice,
  sanitizePhysicalSettings,
  storeKindOf,
  storeVariantsOf,
  webOrderAmounts,
  type StoreKind,
  type VariantChoice,
  type WebChargeContext,
} from "./storefront-physical";
import { loadShippingConfig } from "../shipping/shipping.service";
import { enabledDeliveryTypes, parseDeliveryType, shippingOn, type ShippingConfig } from "../shipping/shipping-config";
import { searchAgencies } from "../shipping/agency-search";
import { resolveOrderShipping, type OrderShippingErrorCode } from "../shipping/order-shipping-resolver";
import { createOrderForStoreOrder, type StoreShippingSnapshot } from "./storefront-order.service";
import { companyTracksStock } from "../orders/orders.service";

// ---------------------------------------------------------------------------
// Portada: tipos de la configuración (JSON) y valores por defecto
// ---------------------------------------------------------------------------

export type HeroSlideStyle = "ambiente" | "tarjeta" | "poster";
export const HERO_STYLES: HeroSlideStyle[] = ["ambiente", "tarjeta", "poster"];
export type HeroSlide = {
  productId: string;
  kicker: string;
  headline: string;
  sub: string;
  imageUrl: string | null;
  bg: string | null;
  /** Estilo del slide (ambiente | tarjeta | poster). */
  style?: HeroSlideStyle;
  /** Parte del titular que va en color de acento (debe aparecer dentro del titular). */
  highlight?: string;
  /** Hasta 3 frases cortas (chips en "ambiente", lista ✓ en "tarjeta"). */
  bullets?: string[];
  /** Prueba social, ej. "+2,300 compras". */
  socialProof?: string;
  /** Color de acento del banner (resaltado, badges) y color del botón. */
  accentColor?: string | null;
  ctaColor?: string | null;
  ctaLabel?: string;
};
export type TrustItem = { title: string; sub: string; icon?: string | null };
export type StoreFaq = { question: string; answer: string };

export type StoreMediaType = "IMAGE" | "VIDEO" | "PDF" | "OTHER";
export type StoreMediaItem = { url: string; type: StoreMediaType; title?: string | null; description?: string | null; cta?: boolean | null; ctaLabel?: string | null };

/** Resuelve spintax de forma fija (primera opción de cada {a|b|c}) y colapsa espacios: texto estable para la tienda. */
export function firstSpintax(text: string | null | undefined): string {
  let t = String(text ?? "");
  for (let i = 0; i < 5 && /\{[^{}]*\|[^{}]*\}/.test(t); i++) t = t.replace(/\{([^{}]*)\}/g, (_m, body: string) => body.split("|")[0] ?? "");
  return t.replace(/\s+/g, " ").trim();
}
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
  /** Imágenes del producto que la tienda NO muestra (solo tienda; el producto no cambia). */
  hiddenImages?: string[] | null;
  /** Landing de ventas de la ficha (hero, cifras, dolor, muestra, testimonios, order bump, garantía). */
  landing?: LandingOverride | null;
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
function hiddenOf(ov?: ProductOverride): Set<string> {
  return new Set((ov?.hiddenImages ?? []).filter((u) => typeof u === "string"));
}

/** Imágenes de presentación visibles en la tienda (sin las ocultas). */
function visibleImagesOf(p: { files: { type: string; showInPresentation: boolean; url: string }[] }, ov?: ProductOverride): string[] {
  const hidden = hiddenOf(ov);
  return p.files.filter((f) => f.type === "IMAGE" && f.showInPresentation && !hidden.has(f.url)).map((f) => f.url);
}

function storeImageOf(p: { files: { type: string; showInPresentation: boolean; url: string }[] }, ov?: ProductOverride): string | null {
  const hidden = hiddenOf(ov);
  if (ov?.imageUrl && !hidden.has(ov.imageUrl)) return ov.imageUrl;
  return visibleImagesOf(p, ov)[0] ?? null;
}

export const DEFAULT_TRUST_ITEMS: TrustItem[] = [
  { icon: "⚡", title: "Entrega inmediata", sub: "El acceso llega a tu correo al confirmar el pago" },
  { icon: "◎", title: "Yape, Plin o tarjeta", sub: "Pago seguro y validación automática" },
  { icon: "✆", title: "Soporte por WhatsApp", sub: "Te ayudamos antes y después de comprar" },
];

/** Textos de confianza por defecto de una tienda física (según lo que el negocio ofrece hoy). */
function physicalTrustItems(entregas: { label: string }[], canPayOnline: boolean): TrustItem[] {
  const formas = entregas.map((e) => e.label.toLowerCase());
  return [
    { icon: "🚚", title: "Recibe tu pedido", sub: formas.length ? `${formas.join(", ").replace(/^./, (c) => c.toUpperCase())}` : "Coordinamos la entrega contigo" },
    canPayOnline
      ? { icon: "◎", title: "Yape, Plin o tarjeta", sub: "Pago seguro y validación automática" }
      : { icon: "◎", title: "Pago contra entrega", sub: "Pagas cuando recibes tu pedido" },
    { icon: "✆", title: "Soporte por WhatsApp", sub: "Te ayudamos antes y después de comprar" },
  ];
}
const PHYSICAL_GUARANTEE_TEXT = "Si el producto no es lo que prometimos, te devolvemos tu dinero.";

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

export { storeUrl } from "./storefront-url";
import { storeUrl } from "./storefront-url";

type StoreCompany = {
  id: string;
  name: string;
  slug: string;
  currency: string;
  timezone: string;
  isActive: boolean;
  vertical: string;
};

/** Empresa + config de tienda por slug. Lanza 404 si no existe o no está activa. */
async function resolveStore(slug: string) {
  const s = slug.trim().toLowerCase();
  if (!isValidStoreSlug(s)) throw new AppError("Tienda no encontrada", 404);
  const company = await prisma.company.findUnique({
    where: { slug: s },
    select: { id: true, name: true, slug: true, currency: true, timezone: true, isActive: true, vertical: true },
  });
  if (!company || !company.isActive) throw new AppError("Tienda no encontrada", 404);
  const cfg = await prisma.storefrontConfig.findUnique({ where: { companyId: company.id } });
  if (!cfg || !cfg.enabled) throw new AppError("Tienda no encontrada", 404);
  const ent = await getEntitlements(company.id);
  if (ent.blocked || !(ent.legacy || ent.modules.includes("STOREFRONT"))) {
    throw new AppError("Tienda no disponible", 404);
  }
  // El tipo de tienda lo decide el servidor: física solo en el rubro comercial y con la opción activada.
  const kind: StoreKind = storeKindOf(company.vertical, cfg.physical);
  return { company: company as StoreCompany, cfg, ent, kind };
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

/**
 * Productos elegibles. Tienda digital: digitales, activos, en catálogo, entrega fija y
 * con correo. Tienda física: físicos, activos, en catálogo y con precio simple (los de
 * precio por plan o con opciones que cambian el precio quedan fuera).
 */
async function eligibleProducts(companyId: string, productIds: string[], kind: StoreKind = "DIGITAL") {
  if (kind === "PHYSICAL") {
    const physical = await prisma.product.findMany({
      where: { companyId, active: true, showInCatalog: true, productType: "PHYSICAL", ...(productIds.length ? { id: { in: productIds } } : {}) },
      include: productRelations,
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    return physical.filter(isSimplePhysicalProduct);
  }
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
  // Recargo de Mercado Pago que paga el COMPRADOR (solo si el negocio lo traslada): la tienda
  // lo muestra antes de redirigir para que el monto del link no sorprenda.
  const mpRecargo =
    mercadoPago && pc && pc.mpFeeMode === "CUSTOMER"
      ? { percent: Number(pc.mpFeePercent), fixed: Number(pc.mpFeeFixed), igv: pc.mpFeeIgv }
      : null;
  return { mercadoPago, manual, mpRecargo, pc };
}

export async function getPublicStore(slug: string) {
  const { company, cfg, ent, kind } = await resolveStore(slug);
  const symbol = symbolFor(company.currency);
  const isPhysical = kind === "PHYSICAL";
  const physical = physicalSettingsOf(cfg.physical);
  const products = await eligibleProducts(company.id, cfg.productIds, kind);
  const [pay, metaPixelId, shipCfg, tracksStock] = await Promise.all([
    storePaymentOptions(company.id, cfg, ent),
    storePixelId(company.id),
    isPhysical ? loadShippingConfig(company.id) : null,
    isPhysical ? companyTracksStock(company.id) : false,
  ]);
  const canPayOnline = pay.mercadoPago || pay.manual.length > 0;
  // Entrega y cobro que ofrece la web: salen de Empresa → Envíos, la tienda no tiene reglas propias.
  const entregas = isPhysical
    ? publicDeliveryOptions(shipCfg, { paymentMode: pay.pc?.paymentMode, codEnabled: physical.codEnabled, canPayOnline, symbol })
    : [];
  const overrides = overridesOf(cfg);
  const mapped = products
    .map((p, idx) => {
      const ov = overrides[p.id];
      const b = mapBotProduct(p, { currencySymbol: symbol, timezone: company.timezone });
      const cover = storeImageOf(p, ov);
      const images = [
        ...(cover ? [{ url: cover, description: "" }] : []),
        ...visibleImagesOf(p, ov).filter((u) => u !== cover).map((u) => ({ url: u, description: "" })),
      ];
      const categories = categoriesOf(ov, b.category);
      return {
        p,
        b,
        ov,
        images,
        categories,
        category: categories[0] ?? null,
        // Título/descripción solo si el dueño los puso (sin ellos, la tienda muestra solo el archivo).
        recursos: mediaOf(ov).map((m) => ({
          type: m.type,
          url: m.url,
          title: (m.title ?? "").trim() || null,
          description: (m.description ?? "").trim() || null,
          cta: m.cta === true,
          ctaLabel: (m.ctaLabel ?? "").trim() || null,
        })),
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
        style: HERO_STYLES.includes(sl.style as HeroSlideStyle) ? (sl.style as HeroSlideStyle) : "ambiente",
        highlight: (sl.highlight ?? "").trim(),
        bullets: (sl.bullets ?? []).map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 3),
        socialProof: (sl.socialProof ?? "").trim(),
        accentColor: sl.accentColor || null,
        ctaColor: sl.ctaColor || null,
        ctaLabel: (sl.ctaLabel ?? "").trim() || "Comprar ahora",
        priceText: b.priceText ?? b.price,
        regularPriceText: b.regularPriceText,
        discountPct: discountPct(b.price, b.regularPrice),
        // Urgencia real: solo si el producto tiene oferta con fecha de fin.
        offerEndsAt: b.offerEndsAt ? b.offerEndsAt.toISOString() : null,
      };
    });
  const categorias = Array.from(new Set(mapped.flatMap((x) => x.categories)));
  const ventas = salesSettingsOf(cfg.salesSettings);
  const combos = volumePricingOf(cfg.volumePricing);
  const anuncio = announcementOf(cfg.announcement);
  // Countdown de la barra: "offer" = la oferta con fin más próxima entre los productos visibles.
  const nearestOffer = mapped
    .map((x) => x.b.offerEndsAt)
    .filter((d): d is Date => Boolean(d && d.getTime() > Date.now()))
    .sort((a, b2) => a.getTime() - b2.getTime())[0];
  const anuncioEndsAt = anuncio.countdown === "offer" ? (nearestOffer ? nearestOffer.toISOString() : null) : anuncio.countdown === "none" ? null : new Date(anuncio.countdown).toISOString();
  const bundlePriceText = combos.allBundle.price !== null ? `${symbol} ${combos.allBundle.price.toFixed(2)}` : "";
  const trust = jsonArray<TrustItem>(cfg.trustItems).length
    ? jsonArray<TrustItem>(cfg.trustItems).slice(0, 4)
    : isPhysical
      ? physicalTrustItems(entregas, canPayOnline)
      : DEFAULT_TRUST_ITEMS;
  // El combo «todos los productos» es solo de la tienda digital.
  const allBundleOn = combos.allBundle.enabled && !isPhysical;
  // Combos armados (solo tienda física): se publican los que tienen todos sus productos visibles
  // y de verdad bajan la suma de los precios vigentes; el carrito aplica la misma regla.
  const money = (n: number) => `${symbol} ${n.toFixed(2)}`;
  const combosArmados =
    isPhysical && combos.enabled
      ? combos.bundles
          .filter((bd) => bd.enabled && bd.productIds.every((id) => byId.has(id)))
          .map((bd) => {
            const parts = bd.productIds.map((id) => byId.get(id)!);
            const regular = Number(parts.reduce((acc, x) => acc + parsePrice(x.b.price), 0).toFixed(2));
            return { bd, parts, regular, saving: Number((regular - bd.price).toFixed(2)) };
          })
          .filter((x) => x.saving > 0)
          .map(({ bd, parts, regular, saving }) => ({
            id: bd.id,
            name: bd.name,
            price: bd.price,
            priceText: money(bd.price),
            regularPrice: regular,
            regularPriceText: money(regular),
            ahorro: saving,
            ahorroText: money(saving),
            agotado: tracksStock && parts.some((x) => typeof x.p.stock === "number" && x.p.stock <= 0),
            productos: parts.map((x) => ({ id: x.p.id, slug: x.b.slug, name: x.p.name, imageUrl: x.images[0]?.url ?? null })),
          }))
      : [];
  const guaranteeText = (text: string) => (isPhysical && text === DEFAULT_GUARANTEE.text ? PHYSICAL_GUARANTEE_TEXT : text);
  return {
    kind,
    envio: isPhysical ? { tipos: entregas, maxPorProducto: physical.maxQtyPerItem, prefijoTelefono: defaultDialPrefix(company.currency) } : null,
    pagos: { mercadoPago: pay.mercadoPago, manual: pay.manual, mpRecargo: pay.mpRecargo },
    portada: { slides, autoplay: cfg.carouselAutoplay, intervalSec: cfg.carouselIntervalSec },
    anuncio: anuncio.enabled && anuncio.text ? { text: anuncio.text, endsAt: anuncioEndsAt && new Date(anuncioEndsAt).getTime() > Date.now() ? anuncioEndsAt : null } : null,
    combos: combos.enabled && (combos.tiers.length || allBundleOn || combosArmados.length)
      ? {
          ...(isPhysical ? { bundles: combosArmados } : {}),
          tiers: combos.tiers,
          allBundle: allBundleOn ? { price: combos.allBundle.price as number, priceText: bundlePriceText, label: combos.allBundle.label, total: mapped.length } : null,
          seccion: allBundleOn
            ? {
                kicker: ventas.comboSection.kicker,
                headline: fillPrice(ventas.comboSection.headline, bundlePriceText),
                sub: fillPrice(ventas.comboSection.sub, bundlePriceText),
                ctaLabel: fillPrice(ventas.comboSection.ctaLabel, bundlePriceText),
              }
            : null,
        }
      : null,
    ventas: {
      ctaColor: ventas.ctaColor,
      catalogTitle: ventas.catalogTitle || null,
      guarantee: ventas.guarantee.enabled ? { days: ventas.guarantee.days, title: ventas.guarantee.title.replace(/\{dias\}/g, String(ventas.guarantee.days)), text: guaranteeText(ventas.guarantee.text) } : null,
      cartRecommendations: ventas.cartRecommendations,
      landingBar: ventas.landingBar,
      footer: ventas.footer,
      ctaEffect: ventas.ctaEffect,
    },
    confianza: trust.map((t) => ({ icon: (t.icon ?? "").trim() || null, title: t.title, sub: t.sub })),
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
    productos: mapped.map(({ p, b, ov, images, category, categories, recursos, shortDescription }) => {
      const ld = ov?.landing ?? {};
      const priceText = b.priceText ?? b.price;
      // El order bump es solo de la tienda digital.
      const bump = !isPhysical && ld.orderBump && byId.has(ld.orderBump.productId) ? byId.get(ld.orderBump.productId)! : null;
      const tracked = isPhysical && tracksStock && typeof p.stock === "number";
      const video = videoEmbedUrl(ld.videoUrl ?? null);
      const guarantee = ld.guarantee ? guaranteeOf(ld.guarantee, ventas.guarantee) : ventas.guarantee;
      const landing = {
        kicker: (ld.kicker ?? "").trim() || category || "",
        headline: (ld.headline ?? "").trim() || b.name,
        ctaLabel: (ld.ctaLabel ?? "").trim() || "Comprar ahora →",
        video: video ? { kind: video.kind, url: ld.videoUrl as string, embedUrl: video.embedUrl } : null,
        stats: ld.stats ?? [],
        pain: ld.pain && (ld.pain.headline || ld.pain.items.length) ? ld.pain : null,
        includesHeadline: (ld.includesHeadline ?? "").trim() || `Todo esto por ${priceText}`,
        // Cabecera de "Muestra" solo si el dueño escribió algo (sin textos inventados); los recursos se ven igual.
        sample: ld.sample && Object.values(ld.sample).some((v) => typeof v === "string" && v.trim())
          ? { ...DEFAULT_SAMPLE, kicker: "", headline: "", text: "", ...ld.sample }
          : null,
        testimonialsHeadline: (ld.testimonialsHeadline ?? "").trim() || "Lo que dicen otros clientes",
        testimonials: ld.testimonials ?? [],
        orderBump: bump && ld.orderBump
          ? {
              productId: bump.p.id,
              name: bump.p.name,
              price: ld.orderBump.price,
              priceText: `${symbol} ${ld.orderBump.price.toFixed(2)}`,
              regularPriceText: bump.b.priceText ?? bump.b.price,
              title: ld.orderBump.title || `Sí, agrega ${bump.p.name} por solo ${symbol} ${ld.orderBump.price.toFixed(2)}`,
              note: ld.orderBump.note || "Oferta válida solo en este checkout.",
              imageUrl: bump.images[0]?.url ?? null,
            }
          : null,
        guarantee: guarantee.enabled ? { days: guarantee.days, title: guarantee.title.replace(/\{dias\}/g, String(guarantee.days)), text: guaranteeText(guarantee.text) } : null,
      };
      return {
        id: b.id,
        // Tienda física: lo que el comprador elige (talla, color…), stock si el negocio lo controla y tiempo de entrega.
        variantes: isPhysical ? storeVariantsOf(p) : [],
        stock: tracked ? Math.max(0, p.stock as number) : null,
        agotado: tracked && (p.stock as number) <= 0,
        tiempoEntrega: isPhysical ? (p.physicalDelivery?.deliveryTime ?? "").trim() || null : null,
        landing,
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
        // FAQ de la ficha: las del producto (menos las ocultas para la tienda) + las propias de la tienda.
        faqs: [
          ...p.faqs.filter((f) => !(ld.faqHiddenIds ?? []).includes(f.id)).map((f) => ({ question: f.question, answer: f.answer })),
          ...(ld.faqExtra ?? []),
        ],
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
  const { company, cfg, kind } = resolved;
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
    const products = await eligibleProducts(company.id, cfg.productIds, kind);
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

/** Ítem guardado en el pedido. Tienda física: suma lo elegido en la ficha (texto y pares grupo/opción). */
export type StoreOrderItem = { productId: string; name: string; unitPrice: number; qty: number; variant?: string | null; options?: VariantChoice[] };

/** Entrega tal como llega del checkout de la tienda física (sin validar). */
export type StoreDeliveryInput = {
  tipo?: string | null;
  direccion?: string | null;
  referencia?: string | null;
  agenciaId?: string | null;
  agenciaTexto?: string | null;
  courier?: string | null;
  documento?: string | null;
  telefonoRecibe?: string | null;
};

export type StoreCheckoutInput = {
  productId?: string;
  productIds?: string[];
  items?: StoreCartItemInput[] | null;
  name: string;
  email?: string | null;
  phone?: string | null;
  method?: StoreCheckoutMethod;
  coupon?: string | null;
  emailMarketing?: boolean;
  bumpProductId?: string | null;
  entrega?: StoreDeliveryInput | null;
  cobro?: string | null;
};

/** Ids de producto de un pedido (carrito o pedido antiguo de un solo producto). */
export function orderProductIds(order: { productId: string; productIds: string[] }): string[] {
  return order.productIds.length ? order.productIds : [order.productId];
}

type EligibleRow = Awaited<ReturnType<typeof eligibleProducts>>[number];

export type CartPricing = {
  items: PricedItem[];
  /** Subtotal de lista del carrito (sin bump). */
  subtotal: number;
  combo: { discount: number; label: string | null; kind: "tier" | "bundle" | null; bundle: boolean; next: { missing: number; discountPct: number } | null; nextBundle: { missing: number; price: number } | null };
  bump: { productId: string; name: string; price: number; regularPrice: number } | null;
  coupon: { couponId: string; code: string; type: string; value: number; discount: number } | null;
  /** Total a cobrar (Yape/Plin exacto; MP le suma el recargo aparte). */
  total: number;
};

/**
 * Precio del carrito con todo aplicado, en este orden: tramos por volumen / bundle total
 * (solo sobre los productos del carrito) → order bump (precio especial de la landing del
 * producto principal) → cupón sobre el resultado. Los ítems salen ya repartidos para MP.
 */
async function priceCart(
  company: StoreCompany,
  cfg: { productIds: string[]; productOverrides: unknown; volumePricing: unknown; physical?: unknown },
  input: { productIds: string[]; bumpProductId?: string | null; coupon?: string | null },
): Promise<CartPricing> {
  const wantedIds = Array.from(new Set(input.productIds));
  if (!wantedIds.length) throw new AppError("Elige al menos un producto", 400);
  const eligible = await eligibleProducts(company.id, cfg.productIds, storeKindOf(company.vertical, cfg.physical));
  const chosen = wantedIds.map((id) => eligible.find((p) => p.id === id)).filter((p): p is EligibleRow => Boolean(p));
  if (chosen.length !== wantedIds.length) throw new AppError(chosen.length ? "Algún producto del carrito ya no está disponible" : "Producto no disponible", 404);
  const symbol = symbolFor(company.currency);
  const listPrice = (p: EligibleRow) => parsePrice(mapBotProduct(p, { currencySymbol: symbol, timezone: company.timezone }).price);
  const items: PricedItem[] = chosen.map((p) => {
    const unitPrice = listPrice(p);
    if (unitPrice <= 0) throw new AppError(`«${p.name}» no tiene un precio válido para compra online`, 409);
    return { productId: p.id, name: p.name, unitPrice, qty: 1 };
  });
  const subtotal = Number(items.reduce((acc, it) => acc + it.unitPrice * it.qty, 0).toFixed(2));
  const combo = computeCombo(items, volumePricingOf(cfg.volumePricing), eligible.map((p) => p.id));
  // Order bump: solo el que declara la landing del producto principal, y si no está ya en el carrito.
  let bump: CartPricing["bump"] = null;
  if (input.bumpProductId && !wantedIds.includes(input.bumpProductId)) {
    const ov = overridesOf(cfg)[chosen[0].id];
    const ob = ov?.landing?.orderBump;
    const bp = ob && ob.productId === input.bumpProductId ? eligible.find((p) => p.id === ob.productId) : null;
    if (!bp || !ob) throw new AppError("Esa oferta adicional ya no está disponible", 404);
    bump = { productId: bp.id, name: bp.name, price: ob.price, regularPrice: listPrice(bp) };
    items.push({ productId: bp.id, name: bp.name, unitPrice: ob.price, qty: 1, bump: true });
  }
  const afterCombo = Number((subtotal - combo.discount + (bump?.price ?? 0)).toFixed(2));
  const coupon = input.coupon?.trim() ? await validateCoupon(company.id, input.coupon, items.map((it) => it.productId), afterCombo) : null;
  const total = Number((afterCombo - (coupon?.discount ?? 0)).toFixed(2));
  if (total <= 0) throw new AppError("El total del pedido debe ser mayor a 0", 409);
  distributeTotal(items, total);
  return { items, subtotal, combo: { discount: combo.discount, label: combo.label, kind: combo.kind, bundle: combo.bundle, next: combo.next, nextBundle: combo.nextBundle }, bump, coupon, total };
}

// ---------------------------------------------------------------------------
// Tienda física: carrito con cantidades y variantes
// ---------------------------------------------------------------------------

/** Línea del carrito tal como llega del navegador. */
export type StoreCartItemInput = { productId: string; qty: number; variante?: Record<string, string> | null };

export type PhysicalCartLine = {
  productId: string;
  name: string;
  qty: number;
  /** Precio de lista por unidad (los descuentos van aparte, no se reparten en las líneas). */
  unitPrice: number;
  variant: VariantChoice[];
  variantLabel: string | null;
};

export type PhysicalCartPricing = {
  lines: PhysicalCartLine[];
  /** Suma de lista de los productos. */
  subtotal: number;
  combo: PhysicalComboResult;
  coupon: CartPricing["coupon"];
  /** Productos con combos, descuento por cantidad y cupón aplicados (sin envío). */
  productsTotal: number;
};

const MAX_CART_LINES = 30;

/**
 * Precio del carrito físico. Valida cada línea contra el catálogo (elegible, variantes,
 * tope por producto y stock si el negocio lo controla), aplica el descuento por cantidad
 * y el cupón sobre los productos; el envío se suma después (webOrderAmounts).
 * `checkVariants: false` solo para previsualizar un cupón desde el carrito.
 */
async function pricePhysicalCart(
  company: StoreCompany,
  cfg: { productIds: string[]; volumePricing: unknown; physical?: unknown },
  input: { items: StoreCartItemInput[]; coupon?: string | null },
  opts: { checkVariants?: boolean } = {},
): Promise<PhysicalCartPricing> {
  if (!input.items.length) throw new AppError("Elige al menos un producto", 400);
  const settings = physicalSettingsOf(cfg.physical);
  const [eligible, tracksStock] = await Promise.all([eligibleProducts(company.id, cfg.productIds, "PHYSICAL"), companyTracksStock(company.id)]);
  const symbol = symbolFor(company.currency);
  const lines: PhysicalCartLine[] = [];
  const qtyByProduct = new Map<string, number>();
  for (const raw of input.items) {
    const p = eligible.find((x) => x.id === raw.productId);
    if (!p) throw new AppError(input.items.length > 1 ? "Algún producto del carrito ya no está disponible" : "Producto no disponible", 404);
    const qty = Math.round(Number(raw.qty));
    if (!Number.isFinite(qty) || qty < 1) throw new AppError(`La cantidad de «${p.name}» no es válida`, 400);
    const unitPrice = parsePrice(mapBotProduct(p, { currencySymbol: symbol, timezone: company.timezone }).price);
    if (unitPrice <= 0) throw new AppError(`«${p.name}» no tiene un precio válido para compra online`, 409);
    let variant: VariantChoice[] = [];
    let variantLabel: string | null = null;
    if (opts.checkVariants !== false) {
      const v = resolveVariantChoice(storeVariantsOf(p), raw.variante);
      if (!v.ok) throw new AppError(`Elige ${v.missing.toLowerCase()} para «${p.name}»`, 400);
      variant = v.choice;
      variantLabel = v.label;
    }
    qtyByProduct.set(p.id, (qtyByProduct.get(p.id) ?? 0) + qty);
    // La misma variante repetida se junta en una sola línea; variantes distintas van aparte.
    const same = lines.find((l) => l.productId === p.id && l.variantLabel === variantLabel);
    if (same) same.qty += qty;
    else lines.push({ productId: p.id, name: p.name, qty, unitPrice, variant, variantLabel });
  }
  if (lines.length > MAX_CART_LINES) throw new AppError("El carrito tiene demasiados productos distintos", 400);
  // Tope y stock se miran por producto (sumando sus variantes): el stock es del producto.
  for (const [productId, qty] of qtyByProduct) {
    const p = eligible.find((x) => x.id === productId) as EligibleRow;
    if (qty > settings.maxQtyPerItem) throw new AppError(`Puedes pedir hasta ${settings.maxQtyPerItem} unidades de «${p.name}»`, 400);
    if (tracksStock && typeof p.stock === "number" && qty > p.stock) {
      throw new AppError(p.stock <= 0 ? `«${p.name}» está agotado` : `Solo quedan ${p.stock} de «${p.name}»`, 409);
    }
  }
  const subtotal = Number(lines.reduce((acc, l) => acc + l.unitPrice * l.qty, 0).toFixed(2));
  // Combos armados y descuento por cantidad. «Todos los productos» es solo de la tienda digital.
  const catalog = new Map(
    eligible.map((p) => [p.id, { name: p.name, unitPrice: parsePrice(mapBotProduct(p, { currencySymbol: symbol, timezone: company.timezone }).price) }]),
  );
  const combo = computePhysicalCombo(
    lines.map((l) => ({ productId: l.productId, name: l.name, unitPrice: l.unitPrice, qty: l.qty })),
    volumePricingOf(cfg.volumePricing),
    catalog,
  );
  const afterCombo = Number((subtotal - combo.discount).toFixed(2));
  // El cupón descuenta sobre los productos, nunca sobre el envío.
  const coupon = input.coupon?.trim() ? await validateCoupon(company.id, input.coupon, Array.from(qtyByProduct.keys()), afterCombo) : null;
  const productsTotal = Number((afterCombo - (coupon?.discount ?? 0)).toFixed(2));
  if (productsTotal <= 0) throw new AppError("El total del pedido debe ser mayor a 0", 409);
  return {
    lines,
    subtotal,
    combo,
    coupon,
    productsTotal,
  };
}

/** Líneas del carrito físico: `items`, o `productIds` como cantidad 1 (carritos y enlaces viejos). */
function cartItemsOf(input: { items?: StoreCartItemInput[] | null; productIds?: string[] | null }): StoreCartItemInput[] {
  if (input.items?.length) return input.items;
  return Array.from(new Set(input.productIds ?? [])).map((productId) => ({ productId, qty: 1 }));
}

/** Entrega y cobro de la web para una tienda física: config de Envíos + lo que la tienda permite. */
async function physicalChargeContext(
  company: StoreCompany,
  cfg: { manualPaymentsEnabled: boolean; physical?: unknown },
  ent: { legacy: boolean; modules: string[] },
): Promise<{ shipCfg: ShippingConfig | null; ctx: WebChargeContext; pay: Awaited<ReturnType<typeof storePaymentOptions>> }> {
  const [pay, shipCfg] = await Promise.all([storePaymentOptions(company.id, cfg, ent), loadShippingConfig(company.id)]);
  const ctx: WebChargeContext = {
    paymentMode: pay.pc?.paymentMode,
    codEnabled: physicalSettingsOf(cfg.physical).codEnabled,
    canPayOnline: pay.mercadoPago || pay.manual.length > 0,
    symbol: symbolFor(company.currency),
  };
  return { shipCfg, ctx, pay };
}

type StoreQuoteInput = {
  productIds?: string[] | null;
  items?: StoreCartItemInput[] | null;
  bumpProductId?: string | null;
  coupon?: string | null;
  /** Tipo de entrega elegido (tienda física). Sin él la cotización llega hasta los productos. */
  entrega?: string | null;
  /** Cómo paga, cuando el negocio deja elegir: 'adelantado' | 'contra_entrega'. */
  cobro?: string | null;
};

/** Cotización de la tienda física: productos, descuentos, envío, total, «pagas ahora» y saldo. */
async function quotePhysicalCart(company: StoreCompany, cfg: Parameters<typeof physicalChargeContext>[1] & Parameters<typeof pricePhysicalCart>[1], ent: { legacy: boolean; modules: string[] }, input: StoreQuoteInput) {
  const [pricing, charge] = await Promise.all([
    pricePhysicalCart(company, cfg, { items: cartItemsOf(input), coupon: input.coupon ?? null }),
    physicalChargeContext(company, cfg, ent),
  ]);
  const { shipCfg, ctx, pay } = charge;
  const money = (n: number) => `${ctx.symbol} ${n.toFixed(2)}`;
  const tipos = publicDeliveryOptions(shipCfg, ctx);
  if (!tipos.length || !shipCfg) throw new AppError("Esta tienda aún no tiene formas de entrega disponibles", 409);
  // Con un solo tipo de entrega no hay nada que elegir; con varios, hasta que el comprador elija
  // la cotización muestra solo los productos.
  const pedido = input.entrega?.trim() ? parseDeliveryType(input.entrega) : null;
  if (input.entrega?.trim() && (!pedido || !tipos.some((t) => t.tipo === pedido))) {
    throw new AppError("Ese tipo de entrega no está disponible en esta tienda", 409);
  }
  const tipo = pedido ?? (tipos.length === 1 ? tipos[0].tipo : null);
  const entrega = tipo ? tipos.find((t) => t.tipo === tipo) ?? null : null;
  const web = tipo ? webOrderAmounts(shipCfg, tipo, input.cobro, ctx, pricing.productsTotal) : null;
  if (web && !web.ok) throw new AppError("Ese tipo de entrega no está disponible en esta tienda", 409);
  const total = web?.ok ? web.amounts.total : pricing.productsTotal;
  const payNow = web?.ok ? web.payNow : null;
  const pc = pay.pc;
  // El recargo de Mercado Pago se calcula sobre lo que se paga ahora (total o adelanto).
  const totalMp =
    payNow && pay.mercadoPago && pc
      ? mpLinkAmount(payNow, { feeMode: pc.mpFeeMode, feePercent: Number(pc.mpFeePercent), feeFixed: Number(pc.mpFeeFixed), feeIgv: pc.mpFeeIgv })
      : payNow;
  return {
    kind: "PHYSICAL" as const,
    lineas: pricing.lines.map((l) => ({
      productId: l.productId,
      name: l.name,
      qty: l.qty,
      variante: l.variantLabel,
      unitPrice: l.unitPrice,
      unitPriceText: money(l.unitPrice),
      lineTotal: Number((l.unitPrice * l.qty).toFixed(2)),
      lineTotalText: money(l.unitPrice * l.qty),
    })),
    subtotal: pricing.subtotal,
    subtotalText: money(pricing.subtotal),
    combo:
      pricing.combo.discount > 0
        ? {
            discount: pricing.combo.discount,
            discountText: money(pricing.combo.discount),
            label: pricing.combo.label,
            kind: pricing.combo.kind,
            bundle: false,
            // Combos armados que entraron (juegos completos) y lo que ahorra cada uno.
            combos: pricing.combo.bundles.map((h) => ({ id: h.id, name: h.name, sets: h.sets, ahorro: h.saving, ahorroText: money(h.saving) })),
          }
        : null,
    siguienteTramo: pricing.combo.next,
    siguienteBundle: null,
    // «Agrega X y llévate el combo»: el combo armado más cercano a completarse.
    siguienteCombo: pricing.combo.nextBundle
      ? {
          id: pricing.combo.nextBundle.id,
          name: pricing.combo.nextBundle.name,
          price: pricing.combo.nextBundle.price,
          priceText: money(pricing.combo.nextBundle.price),
          ahorro: pricing.combo.nextBundle.saving,
          ahorroText: money(pricing.combo.nextBundle.saving),
          faltan: pricing.combo.nextBundle.missing,
        }
      : null,
    bump: null,
    cupon: pricing.coupon ? { code: pricing.coupon.code, discount: pricing.coupon.discount, discountText: money(pricing.coupon.discount) } : null,
    productos: pricing.productsTotal,
    productosText: money(pricing.productsTotal),
    entrega:
      entrega && web?.ok
        ? { tipo: entrega.tipo, label: entrega.label, costo: web.amounts.shipping, costoTexto: entrega.costoTexto, fleteEnDestino: web.amounts.shippingPaidAtDestination }
        : null,
    cobro: web?.ok ? { modo: web.option.modo, cobro: web.option.cobro, texto: web.option.texto } : null,
    total,
    totalText: money(total),
    pagasAhora: payNow,
    pagasAhoraText: payNow === null ? null : money(payNow),
    saldo: web?.ok ? web.balance : null,
    saldoText: web?.ok ? money(web.balance) : null,
    totalMp: totalMp === null ? null : Number(totalMp.toFixed(2)),
    totalMpText: totalMp === null ? null : money(totalMp),
  };
}

/** Público: buscador de agencias del checkout, limitado a las couriers con catálogo que usa el negocio. */
export async function searchStoreAgencies(slug: string, query: string, offset = 0) {
  const { company, kind } = await resolveStore(slug);
  if (kind !== "PHYSICAL") throw new AppError("Tienda no encontrada", 404);
  const shipCfg = await loadShippingConfig(company.id);
  const vacio = { total: 0, results: [], hayMas: false, siguienteOffset: null };
  if (!shippingOn(shipCfg) || !enabledDeliveryTypes(shipCfg).includes("AGENCIA")) return vacio;
  const couriers = shipCfg.types.agencia.couriers as string[];
  if (!couriers.length) return vacio;
  return searchAgencies({ query, couriers, offset, limit: 8 });
}

/** Público: cotización del carrito (combo, bump, cupón, total y total con recargo de MP). */
export async function quoteStoreCart(slug: string, input: StoreQuoteInput) {
  const { company, cfg, ent, kind } = await resolveStore(slug);
  if (kind === "PHYSICAL") return quotePhysicalCart(company, cfg, ent, input);
  // Digital: cantidad 1 por producto; las líneas nuevas se leen como ids.
  const productIds = input.productIds?.length ? input.productIds : (input.items ?? []).map((it) => it.productId);
  const [pricing, pay] = await Promise.all([priceCart(company, cfg, { productIds, bumpProductId: input.bumpProductId, coupon: input.coupon }), storePaymentOptions(company.id, cfg, ent)]);
  const symbol = symbolFor(company.currency);
  const money = (n: number) => `${symbol} ${n.toFixed(2)}`;
  const pc = pay.pc;
  const totalMp = pay.mercadoPago && pc ? mpLinkAmount(pricing.total, { feeMode: pc.mpFeeMode, feePercent: Number(pc.mpFeePercent), feeFixed: Number(pc.mpFeeFixed), feeIgv: pc.mpFeeIgv }) : pricing.total;
  return {
    subtotal: pricing.subtotal,
    subtotalText: money(pricing.subtotal),
    combo: pricing.combo.discount > 0 ? { discount: pricing.combo.discount, discountText: money(pricing.combo.discount), label: pricing.combo.label, kind: pricing.combo.kind, bundle: pricing.combo.bundle } : null,
    siguienteTramo: pricing.combo.next,
    siguienteBundle: pricing.combo.nextBundle ? { missing: pricing.combo.nextBundle.missing, price: pricing.combo.nextBundle.price, priceText: money(pricing.combo.nextBundle.price) } : null,
    bump: pricing.bump ? { productId: pricing.bump.productId, name: pricing.bump.name, price: pricing.bump.price, priceText: money(pricing.bump.price) } : null,
    cupon: pricing.coupon ? { code: pricing.coupon.code, discount: pricing.coupon.discount, discountText: money(pricing.coupon.discount) } : null,
    total: pricing.total,
    totalText: money(pricing.total),
    totalMp: Number(totalMp.toFixed(2)),
    totalMpText: money(totalMp),
  };
}

/**
 * Cliente del pedido web: lo crea (pasando por el tope de leads del plan) o actualiza sus
 * datos de contacto. El correo solo se escribe cuando el comprador lo dio.
 */
async function upsertStoreCustomer(
  companyId: string,
  legacy: boolean,
  input: { phone: string; name: string; email: string | null; emailMarketing?: boolean },
) {
  const { phone, name, email } = input;
  const existing = await prisma.customer.findUnique({
    where: { companyId_phone: { companyId, phone } },
    select: { id: true, name: true, email: true },
  });
  if (!legacy && !existing) {
    const allowed = await gateNewLead(companyId, phone);
    if (!allowed) throw new AppError("La tienda no puede recibir compras por el momento", 503);
  }
  const customer = await prisma.customer.upsert({
    where: { companyId_phone: { companyId, phone } },
    update: {
      lastInteractionAt: new Date(),
      ...(email ? { email } : {}),
      ...(existing?.name ? {} : { name }),
    },
    create: {
      companyId,
      phone,
      name,
      ...(email ? { email } : {}),
      status: "activo",
      lastInteractionAt: new Date(),
      metadata: { origin: "storefront", emailMarketing: input.emailMarketing !== false },
    },
    select: { id: true, metadata: true },
  });
  // Consentimiento para promociones por correo (la casilla del checkout). No toca la baja total.
  if (existing && input.emailMarketing !== undefined) {
    const md = (customer.metadata ?? {}) as Record<string, unknown>;
    if (md.emailMarketing !== input.emailMarketing && !md.emailOptOut) {
      await prisma.customer.update({ where: { id: customer.id }, data: { metadata: { ...md, emailMarketing: input.emailMarketing } } }).catch(() => undefined);
    }
  }
  return customer;
}

/** Pedidos contra entrega sin cerrar que un mismo número puede tener abiertos desde la web. */
const MAX_OPEN_COD_ORDERS = 2;

/** Lo que el validador de entrega le dice al comprador (el agente tiene sus propios textos). */
const DELIVERY_ERROR_TEXT: Record<OrderShippingErrorCode, string> = {
  MISSING_TYPE: "Elige cómo quieres recibir tu pedido",
  TYPE_DISABLED: "Ese tipo de entrega no está disponible en esta tienda",
  MISSING_ADDRESS: "Escribe la dirección de entrega",
  MISSING_AGENCY: "Elige la agencia donde recogerás tu pedido",
  AGENCY_INVALID: "Esa agencia ya no está disponible. Elige otra.",
  MISSING_DOCUMENT: "Escribe el DNI de quien recibe el pedido",
  MISSING_PAYMENT_CHOICE: "Elige cómo quieres pagar",
};

/**
 * Checkout de la tienda física. Valida carrito, entrega y cobro contra la configuración
 * de Envíos y guarda en el StoreOrder la foto de lo elegido y de los montos.
 * - Con algo que pagar ahora (total o adelanto): queda PENDIENTE por ese monto y sigue el
 *   cobro de siempre (Mercado Pago o Yape/Plin); el pedido real nace al confirmarse el pago.
 * - Sin nada que pagar ahora (contra entrega): queda CONFIRMADO y el pedido real nace aquí.
 */
async function createPhysicalCheckout(store: Awaited<ReturnType<typeof resolveStore>>, input: StoreCheckoutInput, client?: StoreWebClient | null) {
  const { company, cfg, ent } = store;
  const companyId = company.id;
  const symbol = symbolFor(company.currency);
  const money = (n: number) => `${symbol} ${n.toFixed(2)}`;

  const name = input.name.trim();
  // El WhatsApp es el contacto del pedido: obligatorio, real y con código de país.
  const phoneDigits = buyerPhoneDigits(input.phone, defaultDialPrefix(company.currency));
  if (!phoneDigits) throw new AppError("Escribe tu número de WhatsApp con el código de país", 400);
  const phone = normalizePhone(phoneDigits);
  const rawEmail = (input.email ?? "").trim();
  const email = rawEmail ? normalizeEmail(rawEmail) : null;
  if (rawEmail && !email) throw new AppError("El correo no es válido", 400);

  const wanted = cartItemsOf({ items: input.items, productIds: [...(input.productId ? [input.productId] : []), ...(input.productIds ?? [])] });
  const [pricing, charge] = await Promise.all([
    pricePhysicalCart(company, cfg, { items: wanted, coupon: input.coupon ?? null }),
    physicalChargeContext(company, cfg, ent),
  ]);
  const { shipCfg, ctx, pay } = charge;
  const tipos = publicDeliveryOptions(shipCfg, ctx);
  if (!tipos.length || !shipCfg) throw new AppError("Esta tienda aún no tiene formas de entrega disponibles", 409);

  // Entrega y cobro: los mismos montos que mostró la cotización (webOrderAmounts).
  const e = input.entrega ?? {};
  const tipo = parseDeliveryType(e.tipo) ?? (tipos.length === 1 ? tipos[0].tipo : null);
  if (!tipo) throw new AppError(DELIVERY_ERROR_TEXT.MISSING_TYPE, 400);
  if (!tipos.some((t) => t.tipo === tipo)) throw new AppError(DELIVERY_ERROR_TEXT.TYPE_DISABLED, 409);
  const web = webOrderAmounts(shipCfg, tipo, input.cobro, ctx, pricing.productsTotal, { requireChoice: true });
  if (!web.ok) {
    if (web.code === "MISSING_PAYMENT_CHOICE") throw new AppError(DELIVERY_ERROR_TEXT.MISSING_PAYMENT_CHOICE, 400);
    throw new AppError(DELIVERY_ERROR_TEXT.TYPE_DISABLED, 409);
  }
  const ship = await resolveOrderShipping(
    shipCfg,
    {
      deliveryType: tipo,
      address: e.direccion,
      agencyId: e.agenciaId,
      agencyText: e.agenciaTexto,
      courier: e.courier,
      document: e.documento,
      recipientPhone: e.telefonoRecibe,
      cobro: web.option.cobro,
    },
    { subtotal: pricing.productsTotal, configuredPaymentMode: ctx.paymentMode },
  );
  if (!ship.ok) throw new AppError(DELIVERY_ERROR_TEXT[ship.code], ship.code === "TYPE_DISABLED" ? 409 : 400);

  const amounts = web.amounts;
  const payNow = web.payNow;
  const cod = payNow <= 0;
  const pc = pay.pc;
  const method: StoreCheckoutMethod = input.method ?? (pay.mercadoPago ? "MERCADOPAGO" : "MANUAL");
  if (!cod) {
    if (method === "MERCADOPAGO" && (!pay.mercadoPago || !pc?.mpAccessToken)) {
      throw new AppError("Esta tienda aún no tiene pagos con Mercado Pago habilitados", 409);
    }
    if (method === "MANUAL" && !pay.manual.length) {
      throw new AppError("Esta tienda no acepta pago con Yape/Plin por el momento", 409);
    }
  }
  // Yape/Plin: monto exacto. Mercado Pago: se le suma la comisión según la configuración.
  const linkAmount =
    cod || method === "MANUAL" || !pc
      ? payNow
      : mpLinkAmount(payNow, { feeMode: pc.mpFeeMode, feePercent: Number(pc.mpFeePercent), feeFixed: Number(pc.mpFeeFixed), feeIgv: pc.mpFeeIgv });

  const customer = await upsertStoreCustomer(companyId, ent.legacy, { phone, name, email, emailMarketing: input.emailMarketing });

  if (cod) {
    // Freno a pedidos falsos: un mismo número no acumula pedidos contra entrega sin cerrar.
    const open = await prisma.storeOrder.count({
      where: { companyId, customerId: customer.id, status: "CONFIRMADO", order: { is: { status: { notIn: ["ENTREGADO", "CANCELADO"] } } } },
    });
    if (open >= MAX_OPEN_COD_ORDERS) {
      throw new AppError("Ya tienes pedidos pendientes de entrega. Escríbenos por WhatsApp para coordinar uno nuevo.", 409);
    }
  }

  const items: StoreOrderItem[] = pricing.lines.map((l) => ({
    productId: l.productId,
    name: l.name,
    unitPrice: l.unitPrice,
    qty: l.qty,
    ...(l.variantLabel ? { variant: l.variantLabel, options: l.variant } : {}),
  }));
  const productIds = Array.from(new Set(items.map((it) => it.productId)));
  const productName = items.length > 1 ? `${items[0].name} +${items.length - 1} más` : items[0].name;
  const coupon = pricing.coupon;
  const shipping: StoreShippingSnapshot = {
    deliveryType: tipo,
    address: (e.direccion ?? "").trim(),
    reference: (e.referencia ?? "").trim(),
    courier: ship.shipping.courier ?? null,
    agencyId: ship.shipping.agencyId ?? null,
    agencyName: ship.shipping.agencyName ?? null,
    agencyAddress: ship.shipping.agencyAddress ?? null,
    document: ship.shipping.recipientDocument ?? null,
    recipientPhone: ship.shipping.recipientPhone ?? null,
    cobro: web.option.cobro,
    paymentMode: web.paymentMode ?? null,
    amounts,
  };

  const accessToken = crypto.randomBytes(18).toString("base64url");
  const order = await prisma.storeOrder.create({
    data: {
      companyId,
      customerId: customer.id,
      productId: items[0].productId,
      productName,
      items,
      productIds,
      email,
      name,
      phone,
      amount: new Prisma.Decimal(linkAmount.toFixed(2)),
      orderTotal: new Prisma.Decimal(amounts.total.toFixed(2)),
      shipping: shipping as unknown as Prisma.InputJsonValue,
      currency: company.currency,
      status: cod ? "CONFIRMADO" : "PENDIENTE",
      paymentMethod: cod ? "CONTRA_ENTREGA" : method,
      accessToken,
      metadata: {
        kind: "PHYSICAL",
        listPrice: pricing.subtotal,
        feeMode: cod ? null : pc?.mpFeeMode ?? null,
        ...(coupon ? { coupon: { couponId: coupon.couponId, code: coupon.code, discount: coupon.discount } } : {}),
        // Desglose para la página del pedido, el panel y los correos.
        pricing: {
          subtotal: pricing.subtotal,
          combo: pricing.combo.discount > 0 ? { discount: pricing.combo.discount, label: pricing.combo.label, bundle: false } : null,
          bump: null,
          coupon: coupon ? { code: coupon.code, discount: coupon.discount } : null,
          productsTotal: pricing.productsTotal,
          shipping: amounts.shipping,
          total: amounts.total,
          payNow,
          balance: web.balance,
        },
        ...(client ? { web: client } : {}),
      },
    },
  });

  const base = storeUrl(company.slug);
  const thanks = `${base}/gracias?o=${order.id}&t=${accessToken}`;
  const common = {
    kind: "PHYSICAL" as const,
    orderId: order.id,
    token: accessToken,
    items,
    descuento: coupon ? { code: coupon.code, amount: coupon.discount } : null,
    total: amounts.total,
    totalText: money(amounts.total),
    saldo: web.balance,
    saldoText: money(web.balance),
  };

  if (cod) {
    let real;
    try {
      real = await createOrderForStoreOrder(order.id);
    } catch (err) {
      await prisma.storeOrder
        .update({ where: { id: order.id }, data: { status: "FALLIDO", failureReason: `Pedido: ${err instanceof Error ? err.message : "error"}` } })
        .catch(() => undefined);
      console.error(`[storefront] pedido contra entrega falló company=${companyId}:`, err instanceof Error ? err.message : err);
      throw new AppError("No se pudo registrar tu pedido. Intenta de nuevo en un momento.", 502);
    }
    void recordPurchaseEvent(order);
    void consumeCoupon(order);
    console.log(`[storefront] pedido ${order.id} CONFIRMADO (contra entrega) pedido=${real.orderCode}`);
    return {
      ...common,
      method: "CONTRA_ENTREGA" as const,
      confirmado: true,
      pedido: real.orderCode,
      initPoint: null,
      amount: 0,
      amountText: money(0),
      feeIncluded: false,
      metodos: [] as { method: string; number: string; holder: string }[],
    };
  }

  // Recordatorios por correo si el pago queda a medias (solo si dejó correo; se cancelan al pagar).
  void scheduleAbandonedCheckout(order);
  const pending = { ...common, method, confirmado: false, pedido: null, amount: linkAmount, amountText: money(linkAmount) };

  if (method === "MANUAL") {
    return { ...pending, initPoint: null, feeIncluded: false, metodos: pay.manual };
  }

  let pref;
  try {
    // Un solo ítem por lo que se paga ahora (total o adelanto, con la comisión si aplica):
    // con adelanto no hay forma de repartir el monto entre los productos sin restos.
    pref = await mpCreatePreference(decryptCredential(pc!.mpAccessToken!), {
      title: `${payNow < amounts.total ? "Adelanto de tu pedido" : "Pedido"} en ${company.name}`,
      amount: linkAmount,
      currency: company.currency.toUpperCase(),
      externalReference: JSON.stringify({ storeOrderId: order.id }),
      notificationUrl: `${env.PUBLIC_BASE_URL}/api/webhooks/mercadopago/${companyId}`,
      backUrls: { success: thanks, failure: `${thanks}&r=failure`, pending: `${thanks}&r=pending` },
      autoReturn: base.startsWith("https://"),
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
  return { ...pending, initPoint: pref.init_point, feeIncluded: linkAmount > payNow, metodos: [] as { method: string; number: string; holder: string }[] };
}

export async function createStoreCheckout(slug: string, input: StoreCheckoutInput, client?: StoreWebClient | null) {
  const store = await resolveStore(slug);
  // La tienda física tiene su propio checkout (entrega, cobro y pedido real): nunca pasa
  // por el flujo de entrega digital.
  if (store.kind === "PHYSICAL") return createPhysicalCheckout(store, input, client);
  const { company, cfg, ent } = store;
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

  // Carrito: ids únicos, todos elegibles (digitales: qty 1); combo + order bump + cupón
  // se calculan en priceCart y los ítems salen repartidos (MP no acepta ítems negativos).
  const wantedIds = Array.from(new Set([...(input.productId ? [input.productId] : []), ...(input.productIds ?? [])]));
  const pricing = await priceCart(company, cfg, { productIds: wantedIds, bumpProductId: input.bumpProductId ?? null, coupon: input.coupon ?? null });
  const items: StoreOrderItem[] = pricing.items.map((it) => ({ productId: it.productId, name: it.name, unitPrice: it.unitPrice, qty: it.qty }));
  const product = { id: pricing.items[0].productId, name: pricing.items[0].name };
  const subtotal = pricing.subtotal;
  const coupon = pricing.coupon;
  const productName = items.length > 1 ? `${product.name} +${items.length - 1} más` : product.name;
  const priceNum = pricing.total;
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
  const customer = await upsertStoreCustomer(companyId, ent.legacy, { phone, name, email, emailMarketing: input.emailMarketing });

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
        // Desglose para la página de gracias, el panel y los correos.
        pricing: {
          subtotal,
          combo: pricing.combo.discount > 0 ? { discount: pricing.combo.discount, label: pricing.combo.label, bundle: pricing.combo.bundle } : null,
          bump: pricing.bump ? { productId: pricing.bump.productId, name: pricing.bump.name, price: pricing.bump.price } : null,
          coupon: coupon ? { code: coupon.code, discount: coupon.discount } : null,
          total: pricing.total,
        },
        ...(client ? { web: client } : {}),
      },
    },
  });

  const base = storeUrl(company.slug);
  const thanks = `${base}/gracias?o=${order.id}&t=${accessToken}`;
  const amountText = `${symbolFor(company.currency)} ${linkAmount.toFixed(2)}`;
  // Recordatorios por correo si el pago queda a medias (se cancelan solos al pagar).
  void scheduleAbandonedCheckout(order);

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
    ENTREGADO: `Listo: te enviamos el acceso a ${order.email ?? "tu correo"}. Si no lo ves, revisa spam o promociones.`,
    FALLIDO: "Hubo un inconveniente con tu pedido. Escríbenos y lo resolvemos.",
    CONFIRMADO: "Recibimos tu pedido. Te escribimos por WhatsApp para coordinar la entrega.",
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
  const pricing = ((order.metadata ?? {}) as Record<string, unknown>).pricing ?? null;
  return {
    id: order.id,
    status: order.status,
    paymentMethod: order.paymentMethod,
    productName: order.productName,
    pricing,
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
  void cancelOrderEmails(order.id, "Pedido pagado");
  void schedulePostPurchase(order);

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
    if (!order.email) throw new Error("el pedido no tiene correo");
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

  void cancelOrderEmails(order.id, "El comprador subió su comprobante");

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
  void cancelOrderEmails(order.id, "Pedido rechazado");
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

export const STORE_EVENT_TYPES = ["VIEW", "PRODUCT_VIEW", "ADD_TO_CART", "CHECKOUT", "WA_CLICK", "PURCHASE", "DOWNLOAD", "RESOURCE_VIEW", "EMAIL_CLICK"] as const;
export type StoreEventType = (typeof STORE_EVENT_TYPES)[number];
const STORE_EVENT_RETENTION_DAYS = 180;

/** Eventos enviados por el navegador (lote). Ignora tipos desconocidos; PURCHASE solo lo escribe el backend. */
export async function recordStoreEvents(slug: string, sessionId: string, events: { type: string; productId?: string | null; campaignId?: string | null }[]) {
  const { company } = await resolveStore(slug);
  const sid = sessionId.trim().slice(0, 64);
  if (!sid) return { ok: true, saved: 0 };
  const rows = events
    .filter((e) => (STORE_EVENT_TYPES as readonly string[]).includes(e.type) && e.type !== "PURCHASE" && e.type !== "DOWNLOAD")
    .slice(0, 20)
    .map((e) => ({ companyId: company.id, type: e.type, productId: e.productId || null, campaignId: e.campaignId || null, sessionId: sid }));
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
export type StoreMetricsOpts = { days?: number; from?: string; to?: string; productId?: string | null };

/**
 * Métricas de la tienda por rango de días (YYYY-MM-DD en la zona horaria del negocio) o
 * por `days` hacia atrás, con filtro opcional por producto y el embudo ya armado.
 */
export async function storeMetrics(companyId: string, opts: StoreMetricsOpts | number = 30) {
  const o: StoreMetricsOpts = typeof opts === "number" ? { days: opts } : opts;
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { timezone: true, currency: true } });
  const tz = company?.timezone ?? "America/Lima";
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  const days = Math.min(365, Math.max(1, Math.round(o.days ?? 30)));
  const since = o.from && ymd.test(o.from) ? zonedDayBoundary(o.from, tz, false) : new Date(Date.now() - days * 86_400_000);
  const until = o.to && ymd.test(o.to) ? zonedDayBoundary(o.to, tz, true) : new Date();
  const productId = o.productId || null;
  const events = await prisma.storeEvent.findMany({
    where: { companyId, createdAt: { gte: since, lte: until } },
    select: { type: true, productId: true, sessionId: true },
  });
  const sessions = new Set<string>();
  const count: Record<StoreEventType, number> = { VIEW: 0, PRODUCT_VIEW: 0, ADD_TO_CART: 0, CHECKOUT: 0, WA_CLICK: 0, PURCHASE: 0, DOWNLOAD: 0, RESOURCE_VIEW: 0, EMAIL_CLICK: 0 };
  const buyers = new Set<string>();
  const byProduct = new Map<string, { vistas: number; carrito: number; checkouts: number; compras: number; whatsapp: number; muestras: number }>();
  for (const e of events) {
    // Con filtro de producto solo cuentan los eventos de ese producto (las visitas = sesiones que lo vieron).
    if (productId && e.productId !== productId) continue;
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
  const orderWhere = { companyId, createdAt: { gte: since, lte: until }, ...(productId ? { productIds: { has: productId } } : {}) };
  const [orders, pending, names] = await Promise.all([
    prisma.storeOrder.findMany({ where: { ...orderWhere, status: "ENTREGADO" }, select: { amount: true, currency: true } }),
    prisma.storeOrder.findMany({ where: { ...orderWhere, status: { in: ["PENDIENTE", "EN_REVISION"] } }, select: { amount: true, currency: true } }),
    byProduct.size
      ? prisma.product.findMany({ where: { companyId, id: { in: [...byProduct.keys()] } }, select: { id: true, name: true } })
      : Promise.resolve([] as { id: string; name: string }[]),
  ]);
  const nameOf = new Map(names.map((n) => [n.id, n.name]));
  const ingresos = orders.reduce((acc, o2) => acc + Number(o2.amount), 0);
  const currency = orders[0]?.currency ?? pending[0]?.currency ?? company?.currency ?? "PEN";
  const pendMonto = pending.reduce((acc, o2) => acc + Number(o2.amount), 0);
  const visitas = sessions.size;
  const money = (n: number) => `${symbolFor(currency)} ${n.toFixed(2)}`;
  // Embudo: cada paso con % del paso anterior y % de las visitas (para que se note dónde se cae).
  const steps = [
    { id: "visitas", label: "Visitas", value: visitas, fuente: "Sesiones únicas que abrieron la tienda" },
    { id: "vistas", label: "Vistas de producto", value: count.PRODUCT_VIEW, fuente: "Aperturas de una ficha (PRODUCT_VIEW)" },
    { id: "carrito", label: "Agregaron al carrito", value: count.ADD_TO_CART, fuente: "Clics en «Agregar» (ADD_TO_CART)" },
    { id: "checkout", label: "Iniciaron el pago", value: count.CHECKOUT, fuente: "Pulsaron «Pagar» (CHECKOUT)" },
    { id: "compras", label: "Compras", value: orders.length, fuente: "Pedidos entregados" },
  ];
  const embudo = steps.map((st, i) => ({
    ...st,
    pctPrev: i === 0 ? null : steps[i - 1].value > 0 ? Number(((st.value / steps[i - 1].value) * 100).toFixed(1)) : null,
    pctVisitas: i === 0 ? null : visitas > 0 ? Number(((st.value / visitas) * 100).toFixed(1)) : null,
  }));
  return {
    dias: days,
    rango: { from: since.toISOString(), to: until.toISOString() },
    productId,
    visitas,
    vistasProducto: count.PRODUCT_VIEW,
    agregadosAlCarrito: count.ADD_TO_CART,
    checkouts: count.CHECKOUT,
    clicsWhatsApp: count.WA_CLICK,
    compras: orders.length,
    descargas: count.DOWNLOAD,
    clicsCorreo: count.EMAIL_CLICK,
    ingresos: Number(ingresos.toFixed(2)),
    ingresosText: money(ingresos),
    ticketPromedio: orders.length ? Number((ingresos / orders.length).toFixed(2)) : 0,
    ticketPromedioText: money(orders.length ? ingresos / orders.length : 0),
    pendientes: { pedidos: pending.length, monto: Number(pendMonto.toFixed(2)), montoText: money(pendMonto) },
    conversion: visitas > 0 ? Number(((buyers.size / visitas) * 100).toFixed(1)) : null,
    embudo,
    porProducto: [...byProduct.entries()]
      .map(([pid, m]) => ({ productId: pid, name: nameOf.get(pid) ?? "(producto eliminado)", ...m }))
      .sort((a, b) => b.compras - a.compras || b.vistas - a.vistas)
      .slice(0, 20),
  };
}

/**
 * Borra un pedido (pruebas) con lo relacionado: sus correos programados/enviados, sus eventos
 * de analítica y el comprobante que creó, si nada más lo referencia. No toca cliente ni chat.
 */
export async function deleteStoreOrder(companyId: string, orderId: string) {
  const order = await prisma.storeOrder.findFirst({ where: { id: orderId, companyId }, select: { id: true, receiptId: true, productName: true } });
  if (!order) throw new AppError("Pedido no encontrado", 404);
  const [emails, events] = await Promise.all([
    prisma.storeEmail.deleteMany({ where: { companyId, orderId } }),
    prisma.storeEvent.deleteMany({ where: { companyId, orderId } }),
  ]);
  await prisma.storeOrder.delete({ where: { id: orderId } });
  let comprobante: "borrado" | "conservado" | "ninguno" = "ninguno";
  if (order.receiptId) {
    try {
      await prisma.paymentReceipt.delete({ where: { id: order.receiptId } });
      comprobante = "borrado";
    } catch {
      comprobante = "conservado";
    }
  }
  return { ok: true, pedido: order.productName, correos: emails.count, eventos: events.count, comprobante };
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
export async function previewCoupon(slug: string, code: string, productIds: string[], items?: StoreCartItemInput[] | null) {
  const { company, cfg, kind } = await resolveStore(slug);
  if (kind === "PHYSICAL") {
    // Físico: el cupón descuenta sobre los productos con cantidades (después del descuento por cantidad, antes del envío).
    if (!code.trim()) throw new AppError("Escribe el código del cupón", 400);
    const pricing = await pricePhysicalCart(company, cfg, { items: cartItemsOf({ items, productIds }), coupon: code }, { checkVariants: false });
    const r = pricing.coupon as NonNullable<PhysicalCartPricing["coupon"]>;
    const sym = symbolFor(company.currency);
    return {
      valid: true,
      code: r.code,
      discount: r.discount,
      discountText: `${sym} ${r.discount.toFixed(2)}`,
      total: pricing.productsTotal,
      totalText: `${sym} ${pricing.productsTotal.toFixed(2)}`,
      descripcion: r.type === "PERCENT" ? `${r.value}% de descuento` : `${sym} ${r.value.toFixed(2)} de descuento`,
    };
  }
  const eligible = await eligibleProducts(company.id, cfg.productIds, kind);
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

/** Campos JSON de venta resueltos con defaults (para el panel y el copiloto). */
function resolvedSales(cfg: { emailReminders: unknown; announcement: unknown; volumePricing: unknown; salesSettings: unknown }) {
  const emailReminders: EmailReminders = emailRemindersOf(cfg.emailReminders);
  return { emailReminders, announcement: announcementOf(cfg.announcement), volumePricing: volumePricingOf(cfg.volumePricing) as VolumePricing, salesSettings: salesSettingsOf(cfg.salesSettings) };
}

export async function getStorefrontConfig(companyId: string) {
  const cfg =
    (await prisma.storefrontConfig.findUnique({ where: { companyId } })) ??
    (await prisma.storefrontConfig.create({ data: { companyId } }));
  return { ...cfg, ...resolvedSales(cfg), physical: physicalSettingsOf(cfg.physical), status: await storefrontStatus(companyId, cfg.enabled) };
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
    heroSlides?: {
      productId: string;
      kicker?: string;
      headline?: string;
      sub?: string;
      imageUrl?: string | null;
      bg?: string | null;
      style?: string;
      highlight?: string;
      bullets?: string[];
      socialProof?: string;
      accentColor?: string | null;
      ctaColor?: string | null;
      ctaLabel?: string;
    }[];
    carouselAutoplay?: boolean;
    carouselIntervalSec?: number;
    showOldPrice?: boolean;
    trustItems?: TrustItem[] | null;
    faqs?: StoreFaq[];
    footerTagline?: string | null;
    productOverrides?: Record<string, ProductOverride | null>;
    emailReminders?: unknown;
    announcement?: unknown;
    volumePricing?: unknown;
    salesSettings?: unknown;
    /** Tienda de productos físicos (solo rubro comercial): { enabled, codEnabled, maxQtyPerItem, autoConfirm, confirmMessage, agentShareLinks }. */
    physical?: unknown;
    /** true = el panel manda la config completa (reemplaza); false/omitido = parcial, se fusiona con lo guardado (copiloto). */
    replace?: boolean;
  },
) {
  // Modo fusión (copiloto): lo que no venga se conserva; null borra; listas reemplazan.
  const mergeable = data.productOverrides !== undefined || data.salesSettings !== undefined || data.announcement !== undefined || data.volumePricing !== undefined || data.emailReminders !== undefined || data.physical !== undefined;
  if (!data.replace && mergeable) {
    const cur = await prisma.storefrontConfig.findUnique({ where: { companyId }, select: { productOverrides: true, salesSettings: true, announcement: true, volumePricing: true, emailReminders: true, physical: true } });
    const merged = { ...data };
    if (data.productOverrides !== undefined) {
      const current = overridesOf(cur ?? {});
      const next: Record<string, ProductOverride | null> = { ...current };
      for (const [pid, ov] of Object.entries(data.productOverrides)) {
        if (ov === null) delete next[pid];
        else next[pid] = deepMergeJson(current[pid] ?? {}, ov) as ProductOverride;
      }
      merged.productOverrides = next;
    }
    if (data.salesSettings !== undefined) merged.salesSettings = deepMergeJson(cur?.salesSettings ?? {}, data.salesSettings);
    if (data.announcement !== undefined) merged.announcement = deepMergeJson(cur?.announcement ?? {}, data.announcement);
    if (data.volumePricing !== undefined) merged.volumePricing = deepMergeJson(cur?.volumePricing ?? {}, data.volumePricing);
    if (data.emailReminders !== undefined) merged.emailReminders = deepMergeJson(emailRemindersOf(cur?.emailReminders), data.emailReminders);
    if (data.physical !== undefined) merged.physical = deepMergeJson(cur?.physical ?? {}, data.physical);
    data = merged;
  }
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const isOwnUpload = (u: string) => u.startsWith(`${base}/uploads/`);
  if (data.logoUrl && !isOwnUpload(data.logoUrl)) throw new AppError("El logo debe ser un archivo subido a FlowApp", 400);
  // Tipo de tienda con el que quedará la config tras este guardado (decide qué productos son válidos).
  const nextKind = data.heroSlides !== undefined || data.productOverrides !== undefined ? await companyStoreKind(companyId, data.physical) : "DIGITAL";
  const eligibleRows = data.heroSlides !== undefined || data.productOverrides !== undefined ? await eligibleProducts(companyId, [], nextKind) : [];
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
        media.push({
          url,
          type: MEDIA_TYPES.includes(m.type) ? m.type : "OTHER",
          title: (m.title ?? "").trim().slice(0, 80) || null,
          description: (m.description ?? "").trim().slice(0, 200) || null,
          ...(m.cta === true ? { cta: true, ctaLabel: (m.ctaLabel ?? "").trim().slice(0, 40) || null } : {}),
        });
      }
      const productImages = new Set(prod.files.filter((f) => f.type === "IMAGE").map((f) => f.url));
      const hiddenImages = Array.from(new Set((ov.hiddenImages ?? []).filter((u) => typeof u === "string" && productImages.has(u))));
      const imageUrl = ov.imageUrl && !hiddenImages.includes(ov.imageUrl) ? ov.imageUrl : null;
      const landing = sanitizeLanding(ov.landing, { isOwnUpload, productFileUrls: new Set(prod.files.map((f) => f.url)), productId: pid, eligibleIds: new Set(eligibleRows.map((p) => p.id)) });
      const clean: ProductOverride = {
        ...(landing ? { landing } : {}),
        ...(imageUrl ? { imageUrl } : {}),
        ...(hiddenImages.length ? { hiddenImages } : {}),
        ...(categories.length ? { categories } : {}),
        ...(ov.shortDescription?.trim() ? { shortDescription: ov.shortDescription.trim().slice(0, 160) } : {}),
        ...(typeof ov.sortOrder === "number" && Number.isFinite(ov.sortOrder) ? { sortOrder: Math.round(ov.sortOrder) } : {}),
        ...(media.length ? { media } : {}),
      };
      if (Object.keys(clean).length) productOverrides[pid] = clean;
    }
    // Modo fusión: conserva tal cual los overrides de productos que hoy no son elegibles (no se pierden si vuelven).
    if (!data.replace) {
      for (const [pid, ov] of Object.entries(data.productOverrides)) {
        if (ov && !productOverrides[pid] && !eligibleRows.some((p) => p.id === pid)) productOverrides[pid] = ov;
      }
    }
  }
  let heroSlides: HeroSlide[] | undefined;
  if (data.heroSlides !== undefined) {
    const eligible = new Set(eligibleRows.map((p) => p.id));
    heroSlides = data.heroSlides.slice(0, 5).map((sl) => {
      if (!eligible.has(sl.productId)) throw new AppError("Un slide apunta a un producto que no está listo para la tienda", 400);
      if (sl.imageUrl && !isOwnUpload(sl.imageUrl)) throw new AppError("La imagen del banner debe ser un archivo subido a FlowApp", 400);
      const hex = (v: string | null | undefined) => (v && /^#[0-9a-fA-F]{6}$/.test(v) ? v : null);
      return {
        productId: sl.productId,
        kicker: (sl.kicker ?? "").trim().slice(0, 40),
        headline: (sl.headline ?? "").trim().slice(0, 120),
        sub: (sl.sub ?? "").trim().slice(0, 240),
        imageUrl: sl.imageUrl || null,
        bg: hex(sl.bg),
        style: HERO_STYLES.includes(sl.style as HeroSlideStyle) ? (sl.style as HeroSlideStyle) : "ambiente",
        highlight: (sl.highlight ?? "").trim().slice(0, 60),
        bullets: (sl.bullets ?? []).map((x) => String(x ?? "").trim().slice(0, 60)).filter(Boolean).slice(0, 3),
        socialProof: (sl.socialProof ?? "").trim().slice(0, 40),
        accentColor: hex(sl.accentColor),
        ctaColor: hex(sl.ctaColor),
        ctaLabel: (sl.ctaLabel ?? "").trim().slice(0, 30),
      };
    });
  }
  const trustItems =
    data.trustItems === undefined
      ? undefined
      : data.trustItems === null
        ? null
        : data.trustItems.slice(0, 4).map((t) => ({ icon: (t.icon ?? "").trim().slice(0, 4) || null, title: (t.title ?? "").trim().slice(0, 60), sub: (t.sub ?? "").trim().slice(0, 140) }));
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
    ...(data.emailReminders !== undefined ? { emailReminders: sanitizeEmailReminders(data.emailReminders) as unknown as Prisma.InputJsonValue } : {}),
    ...(data.announcement !== undefined ? { announcement: sanitizeAnnouncement(data.announcement) as unknown as Prisma.InputJsonValue } : {}),
    ...(data.volumePricing !== undefined ? { volumePricing: sanitizeVolumePricing(data.volumePricing) as unknown as Prisma.InputJsonValue } : {}),
    ...(data.salesSettings !== undefined ? { salesSettings: sanitizeSalesSettings(data.salesSettings) as unknown as Prisma.InputJsonValue } : {}),
    ...(data.physical !== undefined ? { physical: sanitizePhysicalSettings(data.physical) as unknown as Prisma.InputJsonValue } : {}),
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
  return { ...cfg, ...resolvedSales(cfg), physical: physicalSettingsOf(cfg.physical), status: await storefrontStatus(companyId, cfg.enabled) };
}

/**
 * Tipo de tienda de una empresa (panel, Copiloto, agente). `physicalOverride` permite
 * evaluar el tipo con unos ajustes que todavía no se guardaron.
 */
export async function companyStoreKind(companyId: string, physicalOverride?: unknown): Promise<StoreKind> {
  const [company, cfg] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { vertical: true } }),
    physicalOverride === undefined ? prisma.storefrontConfig.findUnique({ where: { companyId }, select: { physical: true } }) : null,
  ]);
  return storeKindOf(company?.vertical, physicalOverride === undefined ? cfg?.physical : physicalOverride);
}

/** Checklist de requisitos de la tienda (para el panel y el copiloto). */
export async function storefrontStatus(companyId: string, enabled: boolean) {
  const [company, pc, ent, cfg] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { slug: true, currency: true, timezone: true, vertical: true } }),
    prisma.paymentConfig.findUnique({
      where: { companyId },
      select: { enabled: true, paymentMode: true, mpEnabled: true, mpAccessToken: true, mpStoreEnabled: true, methods: { select: { method: true } } },
    }),
    getEntitlements(companyId),
    prisma.storefrontConfig.findUnique({ where: { companyId }, select: { productIds: true, manualPaymentsEnabled: true, productOverrides: true, physical: true } }),
  ]);
  const physical = physicalSettingsOf(cfg?.physical);
  const kind = storeKindOf(company?.vertical, cfg?.physical);
  const isPhysical = kind === "PHYSICAL";
  const symbol = symbolFor(company?.currency ?? "PEN");
  const overrides = overridesOf(cfg ?? {});
  const slug = company?.slug ?? "";
  const slugProblema = storeSlugProblem(slug);
  // TODOS los elegibles (no filtrados por la selección): la lista del panel debe mostrar
  // también los ocultos para poder volver a activarlos; la visibilidad la decide productIds.
  const eligible = await eligibleProducts(companyId, [], kind);
  // Digital: productos que no entran por no tener entrega por correo. Físico: los que no
  // entran por no tener un precio simple (texto libre, planes u opciones con recargo).
  const sinCorreo = isPhysical
    ? []
    : await prisma.product.findMany({
        where: {
          companyId,
          active: true,
          showInCatalog: true,
          productType: "DIGITAL",
          OR: [{ digitalDelivery: null }, { digitalDelivery: { is: { OR: [{ emailEnabled: false }, { assignmentMode: { not: "STATIC" } }] } } }],
        },
        select: { id: true, name: true },
      });
  const sinPrecioSimple = isPhysical
    ? (
        await prisma.product.findMany({
          where: { companyId, active: true, showInCatalog: true, productType: "PHYSICAL", id: { notIn: eligible.map((p) => p.id) } },
          select: { id: true, name: true },
        })
      )
    : [];
  const shipCfg = isPhysical ? await loadShippingConfig(companyId) : null;
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
  // Tienda física: Envíos manda. Un tipo de entrega encendido puede no salir en la web
  // (contra entrega sin la opción de la tienda, o cobro con pago sin medios de pago).
  const chargeCtx = { paymentMode: pc?.paymentMode, codEnabled: physical.codEnabled, canPayOnline: pagosListos, symbol };
  const entregas = isPhysical ? publicDeliveryOptions(shipCfg, chargeCtx) : [];
  const tiposEntrega =
    isPhysical && shippingOn(shipCfg)
      ? enabledDeliveryTypes(shipCfg).map((tipo) => {
          const motivo = deliveryBlockedReason(shipCfg, tipo, chargeCtx);
          return { tipo, label: DELIVERY_LABELS[tipo], enWeb: !motivo, motivo };
        })
      : [];
  const conFoto = eligible.filter((p) => storeImageOf(p, overrides[p.id]));
  // En físico los pagos dejan de ser requisito si todo lo que ofrece la web es contra entrega.
  const soloContraEntrega = entregas.length > 0 && entregas.every((e) => e.cobros.every((c) => c.modo === "CONTRA_ENTREGA"));
  const lista = isPhysical
    ? enabled && !slugProblema && moduloTienda && entregas.length > 0 && conFoto.length > 0 && (pagosListos || soloContraEntrega)
    : enabled && !slugProblema && moduloTienda && pagosListos && eligible.length > 0;
  return {
    kind,
    // El modo físico solo existe en el rubro comercial; el panel muestra el interruptor según esto.
    fisicaDisponible: company?.vertical === "PHYSICAL_GOODS",
    envio: isPhysical
      ? {
          enviosEncendido: shippingOn(shipCfg),
          tiposEntrega,
          entregasEnWeb: entregas.map((e) => ({ tipo: e.tipo, label: e.label, costoTexto: e.costoTexto, cobros: e.cobros.map((c) => c.texto) })),
          contraEntregaWeb: physical.codEnabled,
          controlaStock: await companyTracksStock(companyId),
        }
      : null,
    productosSinFoto: isPhysical ? eligible.filter((p) => !storeImageOf(p, overrides[p.id])).map((p) => ({ id: p.id, name: p.name })) : [],
    productosSinPrecioSimple: sinPrecioSimple,
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
        const b = mapBotProduct(p, { currencySymbol: symbol, timezone: company?.timezone ?? "America/Lima" });
        const ov = overrides[p.id];
        return {
          id: p.id,
          name: p.name,
          slug: b.slug,
          stock: isPhysical ? p.stock ?? null : null,
          variantes: isPhysical ? storeVariantsOf(p) : [],
          // Valores del PRODUCTO (base) + override de la tienda por separado, para el modal.
          category: b.category ?? null,
          categories: categoriesOf(ov, b.category),
          shortDescription: b.shortDescription,
          faqs: p.faqs.map((f) => ({ id: f.id, question: f.question, answer: f.answer })),
          priceText: b.priceText ?? b.price,
          regularPriceText: b.regularPriceText,
          imageUrl: storeImageOf(p, ov),
          images: p.files.filter((f) => f.type === "IMAGE" && f.showInPresentation).map((f) => f.url),
          hiddenImages: Array.from(hiddenOf(ov)),
          // Archivos públicos del producto (para elegir recursos de muestra); los privados no tienen URL pública.
          files: p.files
            .filter((f) => !f.privateDownload)
            .map((f) => ({ id: f.id, url: f.url, type: f.type, name: f.originalName || f.url.split("/").pop() || "archivo", description: firstSpintax(f.description).slice(0, 200), showInPresentation: f.showInPresentation })),
          override: ov ?? null,
          order: typeof ov?.sortOrder === "number" ? ov.sortOrder : 1000 + idx,
        };
      })
      .sort((a, b2) => a.order - b2.order)
      .map(({ order: _o, ...rest }) => rest),
    productosSinCorreo: sinCorreo,
    lista,
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
    // Desglose de combo / order bump (si lo hubo).
    descuentoCombo: (md.pricing as { combo?: { discount?: number; label?: string | null } } | undefined)?.combo?.discount ?? null,
    bump: (md.pricing as { bump?: { name?: string; price?: number } } | undefined)?.bump?.name ?? null,
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
