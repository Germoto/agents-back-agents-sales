import { z } from "zod";

export const storeSlugParamsSchema = z.object({
  slug: z.string().trim().min(1).max(60),
});

export const storeCheckoutSchema = z.object({
  // Un producto (compra directa) o varios (carrito). Al menos uno de los dos.
  productId: z.string().uuid().optional(),
  productIds: z.array(z.string().uuid()).min(1).max(10).optional(),
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().min(5).max(160),
  // WhatsApp opcional: si viene, la entrega también sale por WhatsApp.
  phone: z.string().trim().max(30).optional().nullable(),
  // MERCADOPAGO (default) o MANUAL (Yape/Plin con comprobante).
  method: z.enum(["MERCADOPAGO", "MANUAL"]).optional(),
  // Atribución Meta (píxel): cookies _fbp/_fbc y URL de la página (opcionales).
  fbp: z.string().trim().max(120).optional().nullable(),
  fbc: z.string().trim().max(300).optional().nullable(),
  pageUrl: z.string().trim().max(500).optional().nullable(),
  // Sesión anónima de la tienda (analítica).
  sessionId: z.string().trim().max(64).optional().nullable(),
  // Cupón de descuento (código).
  coupon: z.string().trim().max(30).optional().nullable(),
  // Consentimiento para promociones por correo (casilla del checkout).
  emailMarketing: z.boolean().optional(),
  // Order bump de la landing del producto principal (precio especial validado en el backend).
  bumpProductId: z.string().uuid().optional().nullable(),
}).refine((b) => Boolean(b.productId || b.productIds?.length), { message: "Elige al menos un producto", path: ["productId"] });

// POST /order/:id/receipt (multipart: file + payerName)
export const storeReceiptBodySchema = z.object({
  payerName: z.string().trim().max(120).optional().nullable(),
});

// Panel: aprobar / rechazar pedidos Yape/Plin
export const approveStoreOrderSchema = z.object({ note: z.string().trim().max(300).optional().nullable() });
export const rejectStoreOrderSchema = z.object({ reason: z.string().trim().max(300).optional().nullable() });

export const storeOrderParamsSchema = z.object({ id: z.string().uuid() });
export const storeOrderQuerySchema = z.object({ t: z.string().min(8).max(200) });

export const updateStorefrontConfigSchema = z.object({
  // true = config completa (panel); omitido = parcial, se fusiona con lo guardado (copiloto).
  replace: z.boolean().optional(),
  enabled: z.boolean().optional(),
  title: z.string().trim().max(80).nullable().optional(),
  tagline: z.string().trim().max(160).nullable().optional(),
  accentColor: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, "Color hex inválido")
    .nullable()
    .optional(),
  logoUrl: z.string().trim().max(500).nullable().optional(),
  whatsappNumber: z.string().trim().max(30).nullable().optional(),
  productIds: z.array(z.string().uuid()).max(200).optional(),
  manualPaymentsEnabled: z.boolean().optional(),
  // Portada
  heroSlides: z
    .array(
      z.object({
        productId: z.string().uuid(),
        kicker: z.string().trim().max(40).default(""),
        headline: z.string().trim().max(120).default(""),
        sub: z.string().trim().max(240).default(""),
        imageUrl: z.string().trim().max(500).nullable().optional(),
        bg: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
        style: z.enum(["ambiente", "tarjeta", "poster"]).optional(),
        highlight: z.string().trim().max(60).optional(),
        bullets: z.array(z.string().trim().max(60)).max(3).optional(),
        socialProof: z.string().trim().max(40).optional(),
        accentColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
        ctaColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
        ctaLabel: z.string().trim().max(30).optional(),
      }),
    )
    .max(5)
    .optional(),
  carouselAutoplay: z.boolean().optional(),
  carouselIntervalSec: z.coerce.number().int().min(3).max(12).optional(),
  showOldPrice: z.boolean().optional(),
  trustItems: z.array(z.object({ icon: z.string().trim().max(4).nullable().optional(), title: z.string().trim().max(60), sub: z.string().trim().max(140) })).max(4).nullable().optional(),
  faqs: z.array(z.object({ question: z.string().trim().max(200), answer: z.string().trim().max(1000) })).max(10).optional(),
  footerTagline: z.string().trim().max(160).nullable().optional(),
  // Personalización por producto para la tienda (null = quitar el override).
  emailReminders: z.any().optional(),
  // Modo ventas (se sanitizan en el servicio).
  announcement: z.any().optional(),
  volumePricing: z.any().optional(),
  salesSettings: z.any().optional(),
  productOverrides: z
    .record(
      z.string().uuid(),
      z
        .object({
          imageUrl: z.string().trim().max(500).nullable().optional(),
          category: z.string().trim().max(40).nullable().optional(),
          categories: z.array(z.string().trim().max(40)).max(6).nullable().optional(),
          shortDescription: z.string().trim().max(160).nullable().optional(),
          sortOrder: z.number().int().nullable().optional(),
          hiddenImages: z.array(z.string().trim().max(500)).max(50).nullable().optional(),
          media: z
            .array(z.object({ url: z.string().trim().max(500), type: z.enum(["IMAGE", "VIDEO", "PDF", "OTHER"]), title: z.string().trim().max(80).nullable().optional(), description: z.string().trim().max(200).nullable().optional(), cta: z.boolean().nullable().optional(), ctaLabel: z.string().trim().max(40).nullable().optional() }))
            .max(12)
            .nullable()
            .optional(),
          landing: z.any().optional(),
        })
        .nullable(),
    )
    .optional(),
});

export const storeOrdersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(["PENDIENTE", "EN_REVISION", "PAGADO", "ENTREGADO", "FALLIDO"]).optional(),
});

// POST /:slug/events (analítica ligera, lote)
export const storeEventsSchema = z.object({
  sessionId: z.string().trim().min(4).max(64),
  events: z
    .array(z.object({ type: z.string().trim().min(2).max(20), productId: z.string().uuid().optional().nullable(), campaignId: z.string().uuid().optional().nullable() }))
    .min(1)
    .max(20),
});

// Panel: campañas de correo
export const campaignIdParamsSchema = z.object({ id: z.string().uuid() });
const campaignAudienceSchema = z.object({
  source: z.enum(["all", "buyers", "subscribers", "whatsapp", "manual"]).default("buyers"),
  productId: z.string().uuid().nullable().optional(),
  tagId: z.string().uuid().nullable().optional(),
  customerIds: z.array(z.string().uuid()).max(5000).optional(),
  emails: z.array(z.string().trim().max(160)).max(5000).optional(),
  rows: z
    .array(z.object({ email: z.string().trim().max(160), nombre: z.string().trim().max(120).nullable().optional(), campo1: z.string().trim().max(200).nullable().optional(), campo2: z.string().trim().max(200).nullable().optional(), campo3: z.string().trim().max(200).nullable().optional(), cupon: z.string().trim().max(30).nullable().optional() }))
    .max(5000)
    .optional(),
});
export const createCampaignSchema = z.object({
  name: z.string().trim().min(1).max(120),
  subject: z.string().trim().min(1).max(150),
  body: z.string().trim().min(1).max(6000),
  imageUrl: z.string().trim().max(500).nullable().optional(),
  ctaLabel: z.string().trim().max(40).nullable().optional(),
  ctaUrl: z.string().trim().max(500).nullable().optional(),
  couponCode: z.string().trim().max(30).nullable().optional(),
  audience: campaignAudienceSchema.optional(),
});
export const updateCampaignSchema = createCampaignSchema.partial();
export const campaignAudiencePreviewSchema = z.object({ audience: campaignAudienceSchema });
export const campaignTestSchema = z.object({ to: z.string().trim().min(5).max(160) });
export const campaignStartSchema = z.object({ scheduledAt: z.string().datetime().nullable().optional() });
export const emailContactsQuerySchema = z.object({ q: z.string().trim().max(80).default(""), limit: z.coerce.number().int().min(1).max(100).default(30) });

export const storeMetricsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

// POST /:slug/coupon (previsualizar descuento)
export const storeCouponPreviewSchema = z.object({
  code: z.string().trim().min(1).max(30),
  productIds: z.array(z.string().uuid()).min(1).max(10),
});

// POST /:slug/quote — cotización del carrito (combo + bump + cupón)
export const storeQuoteSchema = z.object({
  productIds: z.array(z.string().uuid()).min(1).max(10),
  coupon: z.string().trim().max(30).optional().nullable(),
  bumpProductId: z.string().uuid().optional().nullable(),
});

// Panel: cupones
export const couponIdParamsSchema = z.object({ id: z.string().uuid() });
export const createCouponSchema = z.object({
  code: z.string().trim().min(3).max(30),
  type: z.enum(["PERCENT", "FIXED"]),
  value: z.coerce.number().positive(),
  productIds: z.array(z.string().uuid()).max(200).optional(),
  maxUses: z.coerce.number().int().positive().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  active: z.boolean().optional(),
});
export const updateCouponSchema = z.object({
  active: z.boolean().optional(),
  maxUses: z.coerce.number().int().positive().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  productIds: z.array(z.string().uuid()).max(200).optional(),
});

// POST /:slug/subscribe (bloque "Recibe ofertas" del pie)
export const storeSubscribeSchema = z.object({
  email: z.string().trim().min(5).max(160),
  name: z.string().trim().max(120).optional().nullable(),
});

// Panel: correos
export const storeEmailsQuerySchema = z.object({
  kind: z.enum(["ABANDONED_CHECKOUT", "POST_PURCHASE", "WELCOME", "CAMPAIGN", "TEST"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const storeEmailTestSchema = z.object({
  to: z.string().trim().min(5).max(160),
  subject: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(3000),
  couponCode: z.string().trim().max(30).nullable().optional(),
  kind: z.string().trim().max(30).optional(),
});
