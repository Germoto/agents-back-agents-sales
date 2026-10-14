/**
 * Tienda web — "modo ventas": barra de anuncio, combos por volumen, ajustes de venta
 * (color de CTA, título del catálogo, sección combo, garantía) y landing por producto.
 * Tipos, defaults, sanitizado (lo que se guarda en StorefrontConfig) y el cálculo de
 * precios con combo + order bump (compartido por el checkout y la cotización pública).
 */

import { AppError } from "../../lib/app-error";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Barra superior: countdown "none" | "offer" (oferta más próxima de los productos visibles) | fecha ISO. */
export type Announcement = { enabled: boolean; text: string; countdown: string };

export type VolumeTier = { minQty: number; discountPct: number };
export type VolumePricing = {
  enabled: boolean;
  /** Tramos por cantidad (ordenados por minQty); el mayor que aplique gana. */
  tiers: VolumeTier[];
  /** "Todos los packs" a precio fijo (solo si el carrito trae TODOS los productos visibles). */
  allBundle: { enabled: boolean; price: number | null; label: string };
};

export type ComboSection = { kicker: string; headline: string; sub: string; ctaLabel: string };
export type Guarantee = { enabled: boolean; days: number; title: string; text: string };
export type LandingBar = "top" | "bottom" | "both";
export type FooterSettings = {
  /** auto = oscuro en la landing, claro en el resto; dark/light fuerzan. */
  theme: "auto" | "dark" | "light";
  showSubscribe: boolean;
  subscribeTitle: string;
  subscribeSub: string;
  showPayments: boolean;
  showWhatsapp: boolean;
  note: string;
  /** Línea del negocio (nombre, frase, pagos, WhatsApp, nota). */
  showInfo: boolean;
};
export type SalesSettings = {
  ctaColor: string | null;
  catalogTitle: string;
  comboSection: ComboSection;
  guarantee: Guarantee;
  cartRecommendations: boolean;
  /** Dónde va la barra de compra de la landing al pasar el hero. */
  landingBar: LandingBar;
  footer: FooterSettings;
};

export type LandingStat = { value: string; label: string };
export type LandingPain = { kicker: string; headline: string; items: string[]; solution: string };
export type LandingSample = { kicker: string; headline: string; text: string; externalUrl: string | null; externalLabel: string };
export type LandingTestimonial = { url: string; type: "IMAGE" | "VIDEO" };
export type OrderBump = { productId: string; price: number; title: string; note: string };
/** Personalización de la landing de un producto (solo tienda; el producto del chat no cambia). */
export type LandingOverride = {
  kicker?: string | null;
  headline?: string | null;
  ctaLabel?: string | null;
  /** YouTube/Vimeo o un archivo VIDEO del producto. */
  videoUrl?: string | null;
  stats?: LandingStat[] | null;
  pain?: LandingPain | null;
  includesHeadline?: string | null;
  sample?: Partial<LandingSample> | null;
  testimonialsHeadline?: string | null;
  testimonials?: LandingTestimonial[] | null;
  orderBump?: OrderBump | null;
  /** null/undefined = hereda la garantía de la tienda. */
  guarantee?: Guarantee | null;
};

// ---------------------------------------------------------------------------
// Defaults y lectura tolerante
// ---------------------------------------------------------------------------

export const DEFAULT_CTA_COLOR = "#ffd60a";
export const DEFAULT_COMBO_SECTION: ComboSection = {
  kicker: "COMBO TODO INCLUIDO",
  headline: "Llévate todos los packs por {precio}.",
  sub: "Pagas una vez y recibes todo en tu correo.",
  ctaLabel: "Quiero todo por {precio} →",
};
export const DEFAULT_GUARANTEE: Guarantee = {
  enabled: false,
  days: 7,
  title: "Garantía de {dias} días",
  text: "Si el contenido no es lo que prometimos, te devolvemos tu dinero. Sin preguntas.",
};
export const DEFAULT_FOOTER: FooterSettings = {
  theme: "auto",
  showSubscribe: true,
  subscribeTitle: "Recibe ofertas y novedades",
  subscribeSub: "Te avisamos de lanzamientos y descuentos. Sin spam.",
  showPayments: true,
  showWhatsapp: true,
  note: "",
  showInfo: true,
};
export const DEFAULT_SAMPLE: LandingSample = {
  kicker: "MIRA ANTES DE COMPRAR",
  headline: "Revisa el contenido por dentro.",
  text: "Abre la muestra y comprueba la calidad y el orden del contenido antes de pagar.",
  externalUrl: null,
  externalLabel: "Ver muestra gratis ↗",
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown, max: number): string => String(v ?? "").trim().slice(0, max);
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(",", ".")) : NaN;
  return Number.isFinite(n) ? n : null;
};

export function announcementOf(v: unknown): Announcement {
  const o = obj(v);
  return { enabled: o.enabled === true, text: str(o.text, 140), countdown: str(o.countdown, 40) || "none" };
}

export function volumePricingOf(v: unknown): VolumePricing {
  const o = obj(v);
  const bundle = obj(o.allBundle);
  const tiers = (Array.isArray(o.tiers) ? o.tiers : [])
    .map((t) => ({ minQty: Math.round(num(obj(t).minQty) ?? 0), discountPct: num(obj(t).discountPct) ?? 0 }))
    .filter((t) => t.minQty >= 2 && t.discountPct > 0 && t.discountPct < 100)
    .sort((a, b) => a.minQty - b.minQty)
    .slice(0, 3);
  const price = num(bundle.price);
  return {
    enabled: o.enabled === true,
    tiers,
    allBundle: { enabled: bundle.enabled === true && price !== null && price > 0, price: price !== null && price > 0 ? Number(price.toFixed(2)) : null, label: str(bundle.label, 40) || "Todos los packs" },
  };
}

export function guaranteeOf(v: unknown, base: Guarantee = DEFAULT_GUARANTEE): Guarantee {
  const o = obj(v);
  const days = Math.round(num(o.days) ?? base.days);
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : base.enabled,
    days: Math.min(365, Math.max(1, days)),
    title: str(o.title, 60) || base.title,
    text: str(o.text, 240) || base.text,
  };
}

export function salesSettingsOf(v: unknown): SalesSettings {
  const o = obj(v);
  const combo = obj(o.comboSection);
  const cta = str(o.ctaColor, 7);
  return {
    ctaColor: HEX.test(cta) ? cta : null,
    catalogTitle: str(o.catalogTitle, 60),
    comboSection: {
      kicker: str(combo.kicker, 40) || DEFAULT_COMBO_SECTION.kicker,
      headline: str(combo.headline, 120) || DEFAULT_COMBO_SECTION.headline,
      sub: str(combo.sub, 200) || DEFAULT_COMBO_SECTION.sub,
      ctaLabel: str(combo.ctaLabel, 40) || DEFAULT_COMBO_SECTION.ctaLabel,
    },
    guarantee: guaranteeOf(o.guarantee),
    cartRecommendations: o.cartRecommendations !== false,
    landingBar: o.landingBar === "bottom" || o.landingBar === "both" ? o.landingBar : "top",
    footer: footerOf(o.footer),
  };
}

export function footerOf(v: unknown): FooterSettings {
  const o = obj(v);
  return {
    theme: o.theme === "dark" || o.theme === "light" ? o.theme : "auto",
    showSubscribe: o.showSubscribe !== false,
    subscribeTitle: str(o.subscribeTitle, 60) || DEFAULT_FOOTER.subscribeTitle,
    subscribeSub: str(o.subscribeSub, 120) || DEFAULT_FOOTER.subscribeSub,
    showPayments: o.showPayments !== false,
    showWhatsapp: o.showWhatsapp !== false,
    note: str(o.note, 160),
    showInfo: o.showInfo !== false,
  };
}

// ---------------------------------------------------------------------------
// Sanitizado al guardar (desde el panel o el copiloto)
// ---------------------------------------------------------------------------

export function sanitizeAnnouncement(v: unknown): Announcement {
  const a = announcementOf(v);
  if (a.countdown !== "none" && a.countdown !== "offer" && Number.isNaN(new Date(a.countdown).getTime())) {
    throw new AppError("La cuenta regresiva de la barra debe ser 'none', 'offer' o una fecha", 400);
  }
  return a;
}

export function sanitizeVolumePricing(v: unknown): VolumePricing {
  return volumePricingOf(v);
}

export function sanitizeSalesSettings(v: unknown): SalesSettings {
  return salesSettingsOf(v);
}

/** Id de video de YouTube o Vimeo (null si la URL no es de esas plataformas). */
export function parseVideoUrl(url: string): { kind: "youtube" | "vimeo"; id: string } | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\.|^m\./, "");
    if (host === "youtu.be") return u.pathname.length > 1 ? { kind: "youtube", id: u.pathname.slice(1).split("/")[0] } : null;
    if (host === "youtube.com" || host === "youtube-nocookie.com") {
      const v = u.searchParams.get("v");
      if (v) return { kind: "youtube", id: v };
      const m = /^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{6,})/.exec(u.pathname);
      return m ? { kind: "youtube", id: m[1] } : null;
    }
    if (host === "vimeo.com" || host === "player.vimeo.com") {
      const m = /(\d{6,})/.exec(u.pathname);
      return m ? { kind: "vimeo", id: m[1] } : null;
    }
  } catch {
    return null;
  }
  return null;
}

export function videoEmbedUrl(url: string | null): { kind: "youtube" | "vimeo" | "file"; embedUrl: string } | null {
  if (!url) return null;
  const p = parseVideoUrl(url);
  if (p?.kind === "youtube") return { kind: "youtube", embedUrl: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(p.id)}?autoplay=1&rel=0&playsinline=1` };
  if (p?.kind === "vimeo") return { kind: "vimeo", embedUrl: `https://player.vimeo.com/video/${encodeURIComponent(p.id)}?autoplay=1` };
  return { kind: "file", embedUrl: url };
}

export function sanitizeLanding(
  v: unknown,
  ctx: { isOwnUpload: (u: string) => boolean; productFileUrls: Set<string>; productId: string; eligibleIds: Set<string> },
): LandingOverride | null {
  const o = obj(v);
  if (!Object.keys(o).length) return null;
  const out: LandingOverride = {};
  const kicker = str(o.kicker, 40);
  const headline = str(o.headline, 120);
  const ctaLabel = str(o.ctaLabel, 40);
  const includesHeadline = str(o.includesHeadline, 120);
  const testimonialsHeadline = str(o.testimonialsHeadline, 80);
  if (kicker) out.kicker = kicker;
  if (headline) out.headline = headline;
  if (ctaLabel) out.ctaLabel = ctaLabel;
  if (includesHeadline) out.includesHeadline = includesHeadline;
  if (testimonialsHeadline) out.testimonialsHeadline = testimonialsHeadline;
  const videoUrl = str(o.videoUrl, 500);
  if (videoUrl) {
    const ok = parseVideoUrl(videoUrl) || ctx.productFileUrls.has(videoUrl) || ctx.isOwnUpload(videoUrl);
    if (!ok) throw new AppError("El video de la landing debe ser de YouTube/Vimeo o un archivo subido a FlowApp", 400);
    out.videoUrl = videoUrl;
  }
  const stats = (Array.isArray(o.stats) ? o.stats : [])
    .map((s) => ({ value: str(obj(s).value, 24), label: str(obj(s).label, 60) }))
    .filter((s) => s.value && s.label)
    .slice(0, 4);
  if (stats.length) out.stats = stats;
  const pain = obj(o.pain);
  const painItems = (Array.isArray(pain.items) ? pain.items : []).map((x) => str(x, 140)).filter(Boolean).slice(0, 4);
  const painHeadline = str(pain.headline, 120);
  if (painHeadline || painItems.length) {
    out.pain = { kicker: str(pain.kicker, 40) || "¿TE PASA ESTO?", headline: painHeadline, items: painItems, solution: str(pain.solution, 200) };
  }
  const sample = obj(o.sample);
  const externalUrl = str(sample.externalUrl, 500);
  if (externalUrl && !/^https?:\/\//i.test(externalUrl)) throw new AppError("El enlace de la muestra debe empezar con http(s)://", 400);
  const sampleClean: Partial<LandingSample> = {
    ...(str(sample.kicker, 40) ? { kicker: str(sample.kicker, 40) } : {}),
    ...(str(sample.headline, 120) ? { headline: str(sample.headline, 120) } : {}),
    ...(str(sample.text, 240) ? { text: str(sample.text, 240) } : {}),
    ...(externalUrl ? { externalUrl } : {}),
    ...(str(sample.externalLabel, 40) ? { externalLabel: str(sample.externalLabel, 40) } : {}),
  };
  if (Object.keys(sampleClean).length) out.sample = sampleClean;
  const testimonials: LandingTestimonial[] = [];
  for (const t of (Array.isArray(o.testimonials) ? o.testimonials : []).slice(0, 6)) {
    const url = str(obj(t).url, 500);
    if (!url) continue;
    if (!ctx.isOwnUpload(url) || url.includes("/api/public/dl/")) throw new AppError("Los testimonios deben ser archivos públicos subidos a FlowApp", 400);
    testimonials.push({ url, type: obj(t).type === "VIDEO" ? "VIDEO" : "IMAGE" });
  }
  if (testimonials.length) out.testimonials = testimonials;
  const bump = obj(o.orderBump);
  const bumpId = str(bump.productId, 64);
  if (bumpId) {
    const price = num(bump.price);
    if (!ctx.eligibleIds.has(bumpId) || bumpId === ctx.productId) throw new AppError("El order bump debe ser otro producto visible en la tienda", 400);
    if (price === null || price <= 0) throw new AppError("El order bump necesita un precio mayor a 0", 400);
    out.orderBump = { productId: bumpId, price: Number(price.toFixed(2)), title: str(bump.title, 120), note: str(bump.note, 160) };
  }
  if (o.guarantee && typeof o.guarantee === "object") out.guarantee = guaranteeOf(o.guarantee);
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------------------
// Fusión parcial de JSON (copiloto): objetos campo a campo, listas y primitivos
// reemplazan, `null` explícito borra la clave.
// ---------------------------------------------------------------------------

type JsonObj = Record<string, unknown>;
const isObj = (v: unknown): v is JsonObj => Boolean(v) && typeof v === "object" && !Array.isArray(v);

export function deepMergeJson(base: unknown, patch: unknown): unknown {
  if (!isObj(patch)) return patch;
  const out: JsonObj = isObj(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (isObj(v) && isObj(out[k])) out[k] = deepMergeJson(out[k], v);
    else out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Precios: combo por volumen / bundle total / order bump (puro, sin DB)
// ---------------------------------------------------------------------------

export type PricedItem = { productId: string; name: string; unitPrice: number; qty: number; bump?: boolean };

export type ComboResult = {
  /** Descuento aplicado sobre el subtotal del carrito (sin el bump). */
  discount: number;
  /** "3 o más · −20 %" o la etiqueta del bundle; null si no aplica. */
  label: string | null;
  tier: VolumeTier | null;
  bundle: boolean;
  /** Siguiente tramo alcanzable: cuántos faltan y qué % darían. */
  next: { missing: number; discountPct: number } | null;
};

export function computeCombo(cartItems: PricedItem[], vp: VolumePricing, visibleIds: string[]): ComboResult {
  const none: ComboResult = { discount: 0, label: null, tier: null, bundle: false, next: null };
  if (!vp.enabled) return none;
  const qty = cartItems.reduce((a, it) => a + it.qty, 0);
  const subtotal = Number(cartItems.reduce((a, it) => a + it.unitPrice * it.qty, 0).toFixed(2));
  let tier: VolumeTier | null = null;
  for (const t of vp.tiers) if (qty >= t.minQty) tier = t;
  const nextTier = vp.tiers.find((t) => t.minQty > qty) ?? null;
  let discount = tier ? Number(((subtotal * tier.discountPct) / 100).toFixed(2)) : 0;
  let label = tier ? `${tier.minQty} o más · −${tier.discountPct}%` : null;
  let bundle = false;
  const ids = new Set(cartItems.map((it) => it.productId));
  const hasAll = vp.allBundle.enabled && vp.allBundle.price !== null && visibleIds.length >= 2 && visibleIds.every((id) => ids.has(id));
  if (hasAll) {
    const bundleDiscount = Number((subtotal - (vp.allBundle.price as number)).toFixed(2));
    if (bundleDiscount > discount) {
      discount = bundleDiscount;
      label = vp.allBundle.label;
      bundle = true;
    }
  }
  discount = Math.max(0, Math.min(discount, subtotal));
  const next = !bundle && nextTier ? { missing: nextTier.minQty - qty, discountPct: nextTier.discountPct } : null;
  return { discount, label, tier, bundle, next };
}

/** Reparte un total objetivo entre los ítems proporcionalmente (MP no acepta ítems negativos). */
export function distributeTotal(items: PricedItem[], target: number): void {
  const subtotal = items.reduce((a, it) => a + it.unitPrice * it.qty, 0);
  if (subtotal <= 0 || Math.abs(subtotal - target) < 0.005) return;
  const factor = target / subtotal;
  let acc = 0;
  items.forEach((it, i) => {
    if (i < items.length - 1) {
      it.unitPrice = Number((it.unitPrice * factor).toFixed(2));
      acc += it.unitPrice * it.qty;
    } else {
      it.unitPrice = Number(((target - acc) / it.qty).toFixed(2));
    }
  });
}

/** Precio de la tienda con todo aplicado, para mostrar en el pie/resumen. */
export function fillPrice(text: string, priceText: string): string {
  return text.replace(/\{precio\}/g, priceText);
}
