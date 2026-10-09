import { z } from "zod";

export const storeSlugParamsSchema = z.object({
  slug: z.string().trim().min(1).max(60),
});

export const storeCheckoutSchema = z.object({
  productId: z.string().uuid(),
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().min(5).max(160),
  // WhatsApp opcional: si viene, la entrega también sale por WhatsApp.
  phone: z.string().trim().max(30).optional().nullable(),
});

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
});

export const storeOrdersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
