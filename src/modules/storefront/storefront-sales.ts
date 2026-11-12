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
/** Combo armado: productos concretos (una unidad de cada uno) a un precio fijo por juego. Solo tienda física. */
export type StoreBundle = { id: string; name: string; productIds: string[]; price: number; enabled: boolean };
export type VolumePricing = {
  enabled: boolean;
  /** Tramos por cantidad (ordenados por minQty); el mayor que aplique gana. */
  tiers: VolumeTier[];
  /** "Todos los packs" a precio fijo (solo si el carrito trae TODOS los productos visibles). */
  allBundle: { enabled: boolean; price: number | null; label: string };
  /** Combos armados (tienda física): se aplican por juego completo; el resto sigue los tramos. */
  bundles: StoreBundle[];
};
export const MAX_STORE_BUNDLES = 10;
export const MAX_BUNDLE_PRODUCTS = 6;

export type ComboSection = { kicker: string; headline: string; sub: string; ctaLabel: string };
export type Guarantee = { enabled: boolean; days: number; title: string; text: string };
export type LandingBar = "top" | "bottom" | "both";
export type CtaEffect = "none" | "pulse" | "shine" | "bounce";
const CTA_EFFECTS: CtaEffect[] = ["none", "pulse", "shine", "bounce"];
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
  /** Efecto para resaltar los botones que llevan al checkout. */
  ctaEffect: CtaEffect;
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
  /** FAQ del producto (ids de ProductFaq) que NO se muestran en la tienda. */
  faqHiddenIds?: string[] | null;
  /** FAQ adicionales solo para la tienda (hasta 10). */
  faqExtra?: { question: string; answer: string }[] | null;
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const usedIds = new Set<string>();
  const bundles: StoreBundle[] = (Array.isArray(o.bundles) ? o.bundles : [])
    .map((raw) => {
      const b = obj(raw);
      const ids = (Array.isArray(b.productIds) ? b.productIds : []).map((x) => str(x, 40)).filter((x) => UUID_RE.test(x));
      const bPrice = num(b.price);
      return {
        id: str(b.id, 40),
        name: str(b.name, 60),
        productIds: Array.from(new Set(ids)).slice(0, MAX_BUNDLE_PRODUCTS),
        price: bPrice !== null && bPrice > 0 ? Number(bPrice.toFixed(2)) : 0,
        enabled: b.enabled !== false,
      };
    })
    .filter((b) => b.name && b.productIds.length >= 2 && b.price > 0)
    .slice(0, MAX_STORE_BUNDLES)
    .map((b, i) => {
      // El id identifica al combo en el panel y la tienda: si falta o se repite, se asigna uno.
      let id = b.id && !usedIds.has(b.id) ? b.id : `combo-${i + 1}`;
      while (usedIds.has(id)) id = `${id}x`;
      usedIds.add(id);
      return { ...b, id };
    });
  return {
    enabled: o.enabled === true,
    bundles,
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
    ctaEffect: CTA_EFFECTS.includes(o.ctaEffect as CtaEffect) ? (o.ctaEffect as CtaEffect) : "pulse",
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
  const faqHiddenIds = Array.from(new Set((Array.isArray(o.faqHiddenIds) ? o.faqHiddenIds : []).map((x) => str(x, 64)).filter(Boolean))).slice(0, 50);
  if (faqHiddenIds.length) out.faqHiddenIds = faqHiddenIds;
  const faqExtra = (Array.isArray(o.faqExtra) ? o.faqExtra : [])
    .map((f) => ({ question: str(obj(f).question, 200), answer: str(obj(f).answer, 1000) }))
    .filter((f) => f.question && f.answer)
    .slice(0, 10);
  if (faqExtra.length) out.faqExtra = faqExtra;
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
  /** "3 o más · −20 %" o "Todos los packs (6)"; null si no aplica. */
  label: string | null;
  kind: "tier" | "bundle" | null;
  tier: VolumeTier | null;
  bundle: boolean;
  /** Siguiente tramo alcanzable: cuántos faltan y qué % darían. */
  next: { missing: number; discountPct: number } | null;
  /** Cuántos faltan para completar "todos los packs" (si está activo) y su precio. */
  nextBundle: { missing: number; price: number } | null;
};

/**
 * Regla: si el carrito lleva TODOS los productos visibles y "Todos los packs" está activo,
 * manda el precio fijo (aunque un tramo diera más descuento); los tramos por cantidad
 * aplican solo a carritos parciales. Si el precio fijo no baja la suma de lista, no aplica.
 */
export function computeCombo(cartItems: PricedItem[], vp: VolumePricing, visibleIds: string[]): ComboResult {
  const none: ComboResult = { discount: 0, label: null, kind: null, tier: null, bundle: false, next: null, nextBundle: null };
  if (!vp.enabled) return none;
  const qty = cartItems.reduce((a, it) => a + it.qty, 0);
  const subtotal = Number(cartItems.reduce((a, it) => a + it.unitPrice * it.qty, 0).toFixed(2));
  const ids = new Set(cartItems.map((it) => it.productId));
  const bundleOn = vp.allBundle.enabled && vp.allBundle.price !== null && visibleIds.length >= 2;
  const missingForBundle = bundleOn ? visibleIds.filter((id) => !ids.has(id)).length : 0;
  const hasAll = bundleOn && missingForBundle === 0;
  if (hasAll) {
    const bundleDiscount = Number((subtotal - (vp.allBundle.price as number)).toFixed(2));
    if (bundleDiscount > 0) {
      return { discount: Math.min(bundleDiscount, subtotal), label: `${vp.allBundle.label} (${visibleIds.length})`, kind: "bundle", tier: null, bundle: true, next: null, nextBundle: null };
    }
  }
  let tier: VolumeTier | null = null;
  for (const t of vp.tiers) if (qty >= t.minQty) tier = t;
  const nextTier = vp.tiers.find((t) => t.minQty > qty) ?? null;
  const discount = tier ? Math.max(0, Math.min(Number(((subtotal * tier.discountPct) / 100).toFixed(2)), subtotal)) : 0;
  return {
    discount,
    label: tier ? `${tier.minQty} o más · −${tier.discountPct}%` : null,
    kind: tier ? "tier" : null,
    tier,
    bundle: false,
    next: nextTier ? { missing: nextTier.minQty - qty, discountPct: nextTier.discountPct } : null,
    nextBundle: bundleOn && missingForBundle > 0 ? { missing: missingForBundle, price: vp.allBundle.price as number } : null,
  };
}

export type BundleHit = { id: string; name: string; sets: number; price: number; saving: number };

export type PhysicalComboResult = {
  /** Descuento total sobre los productos: combos armados + tramo por cantidad. */
  discount: number;
  label: string | null;
  kind: "tier" | "bundle" | null;
  /** Combos armados aplicados: juegos completos y lo que ahorra cada uno en total. */
  bundles: BundleHit[];
  tier: VolumeTier | null;
  /** Parte del descuento que viene del tramo (unidades que no entraron en un combo). */
  tierDiscount: number;
  next: { missing: number; discountPct: number } | null;
  /** Combo armado más cercano: qué productos faltan para completarlo. */
  nextBundle: { id: string; name: string; price: number; saving: number; missing: { productId: string; name: string }[] } | null;
};

const round2 = (n: number): number => Number(n.toFixed(2));

/**
 * Descuentos de la tienda física. Primero los combos armados: cada juego completo (una
 * unidad de cada producto del combo) se cobra a su precio fijo; si dos combos comparten
 * un producto, gana el que más ahorra. Las unidades que no entraron en un combo siguen
 * los tramos por cantidad (cuentan aparte). Un combo que no baja la suma de los precios
 * vigentes, o con un producto que ya no está en la tienda, no aplica.
 * `catalog` = productos visibles de la tienda con su precio vigente.
 */
export function computePhysicalCombo(
  cartItems: PricedItem[],
  vp: VolumePricing,
  catalog: Map<string, { name: string; unitPrice: number }>,
): PhysicalComboResult {
  const none: PhysicalComboResult = { discount: 0, label: null, kind: null, bundles: [], tier: null, tierDiscount: 0, next: null, nextBundle: null };
  if (!vp.enabled) return none;
  const left = new Map<string, number>();
  const priceOf = new Map<string, number>();
  for (const it of cartItems) {
    left.set(it.productId, (left.get(it.productId) ?? 0) + it.qty);
    priceOf.set(it.productId, it.unitPrice);
  }
  const subtotal = round2(cartItems.reduce((a, it) => a + it.unitPrice * it.qty, 0));
  const usable = vp.bundles
    .filter((b) => b.enabled && b.productIds.every((id) => catalog.has(id)))
    .map((b) => ({ b, saving: round2(b.productIds.reduce((a, id) => a + (catalog.get(id)?.unitPrice ?? 0), 0) - b.price) }))
    .filter((x) => x.saving > 0)
    .sort((a, b2) => b2.saving - a.saving);
  const hits: BundleHit[] = [];
  for (const { b, saving } of usable) {
    const sets = Math.min(...b.productIds.map((id) => left.get(id) ?? 0));
    if (sets < 1) continue;
    for (const id of b.productIds) left.set(id, (left.get(id) ?? 0) - sets);
    hits.push({ id: b.id, name: b.name, sets, price: b.price, saving: round2(saving * sets) });
  }
  const bundleDiscount = round2(hits.reduce((a, h) => a + h.saving, 0));
  let looseQty = 0;
  let looseSubtotal = 0;
  for (const [id, q] of left) {
    looseQty += q;
    looseSubtotal += q * (priceOf.get(id) ?? 0);
  }
  let tier: VolumeTier | null = null;
  for (const t of vp.tiers) if (looseQty >= t.minQty) tier = t;
  const nextTier = vp.tiers.find((t) => t.minQty > looseQty) ?? null;
  const tierDiscount = tier ? Math.max(0, round2((looseSubtotal * tier.discountPct) / 100)) : 0;
  // Combo más cercano: el comprador ya lleva (suelto) alguno de sus productos y le faltan otros.
  const near = usable
    .map(({ b, saving }) => ({ b, saving, missing: b.productIds.filter((id) => (left.get(id) ?? 0) < 1) }))
    .filter((x) => x.missing.length > 0 && x.missing.length < x.b.productIds.length)
    .sort((a, b2) => a.missing.length - b2.missing.length || b2.saving - a.saving)[0];
  const labels = [
    ...hits.map((h) => (h.sets > 1 ? `${h.name} ×${h.sets}` : h.name)),
    ...(tier && tierDiscount > 0 ? [`${tier.minQty} o más · −${tier.discountPct}%`] : []),
  ];
  return {
    discount: Math.min(round2(bundleDiscount + tierDiscount), subtotal),
    label: labels.length ? labels.join(" + ") : null,
    kind: hits.length ? "bundle" : tier ? "tier" : null,
    bundles: hits,
    tier,
    tierDiscount,
    next: nextTier ? { missing: nextTier.minQty - looseQty, discountPct: nextTier.discountPct } : null,
    nextBundle: near
      ? { id: near.b.id, name: near.b.name, price: near.b.price, saving: near.saving, missing: near.missing.map((id) => ({ productId: id, name: catalog.get(id)?.name ?? "" })) }
      : null,
  };
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
