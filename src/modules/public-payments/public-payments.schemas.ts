import { z } from "zod";

/**
 * Schemas para la API pública /api/public/payments
 *
 * Identificación de company sigue el mismo patrón que /api/bot/config:
 *   ?phone=+51...  -> se resuelve a la company del usuario admin activo.
 */

export const phoneQuerySchema = z.object({
  phone: z
    .string()
    .trim()
    .regex(/^\+?\d{6,20}$/, "El phone debe tener solo digitos y opcionalmente + al inicio"),
});

export const listPendingQuerySchema = phoneQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  since: z.string().datetime().optional(),
  source: z.string().min(1).optional(),
});

export const getOneQuerySchema = phoneQuerySchema;

export const updateStatusBodySchema = z.object({
  status: z.enum(["APROBADO", "RECHAZADO"]),
  reason: z.string().trim().min(1).max(500).optional(),
  customerPhone: z
    .string()
    .trim()
    .regex(/^\+?\d{6,20}$/, "customerPhone inválido")
    .optional(),
  customerName: z.string().trim().min(1).max(200).optional(),
  productId: z.string().uuid().optional(),
  note: z.string().trim().max(1000).optional(),
});

export const updateStatusQuerySchema = phoneQuerySchema;
export const updateStatusParamsSchema = z.object({ id: z.string().uuid() });
