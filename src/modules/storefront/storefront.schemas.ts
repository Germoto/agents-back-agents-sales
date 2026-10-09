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
      }),
    )
    .max(5)
    .optional(),
  carouselAutoplay: z.boolean().optional(),
  carouselIntervalSec: z.coerce.number().int().min(3).max(12).optional(),
  showOldPrice: z.boolean().optional(),
  trustItems: z.array(z.object({ title: z.string().trim().max(60), sub: z.string().trim().max(140) })).max(3).nullable().optional(),
  faqs: z.array(z.object({ question: z.string().trim().max(200), answer: z.string().trim().max(1000) })).max(10).optional(),
  footerTagline: z.string().trim().max(160).nullable().optional(),
  // Personalización por producto para la tienda (null = quitar el override).
  productOverrides: z
    .record(
      z.string().uuid(),
      z
        .object({
          imageUrl: z.string().trim().max(500).nullable().optional(),
          category: z.string().trim().max(40).nullable().optional(),
          shortDescription: z.string().trim().max(160).nullable().optional(),
          sortOrder: z.number().int().nullable().optional(),
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
    .array(z.object({ type: z.string().trim().min(2).max(20), productId: z.string().uuid().optional().nullable() }))
    .min(1)
    .max(20),
});

export const storeMetricsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

// POST /:slug/coupon (previsualizar descuento)
export const storeCouponPreviewSchema = z.object({
  code: z.string().trim().min(1).max(30),
  productIds: z.array(z.string().uuid()).min(1).max(10),
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
