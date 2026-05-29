import { z } from "zod";

/**
 * Schemas para la API pública /api/public/payments
 *
 * Identificación de company sigue el mismo patrón que /api/bot/config:
 *   ?phone=+51...  -> se resuelve a la company del usuario admin activo.
 */

const phoneRegex = /^\+?\d{6,20}$/;

export const phoneQuerySchema = z.object({
  phone: z
    .string()
    .trim()
    .regex(phoneRegex, "El phone debe tener solo digitos y opcionalmente + al inicio"),
});

const receiptStatusEnum = z.enum(["PENDIENTE", "EN_REVISION", "APROBADO", "RECHAZADO"]);

export const listPendingQuerySchema = phoneQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  since: z.string().datetime().optional(),
  source: z.string().min(1).optional(),
  // Nuevos filtros opcionales
  amountPaid: z.union([z.string(), z.number()]).optional(),
  payerName: z.string().min(1).optional(),
  occurredFrom: z.string().datetime().optional(),
  occurredTo: z.string().datetime().optional(),
  paymentSource: z.string().min(1).optional(),
  status: receiptStatusEnum.optional(),
});

export const getOneQuerySchema = phoneQuerySchema;

export const updateStatusBodySchema = z.object({
  status: receiptStatusEnum,
  reason: z.string().trim().min(1).max(500).optional(),
  customerPhone: z.string().trim().regex(phoneRegex, "customerPhone inválido").optional(),
  customerName: z.string().trim().min(1).max(200).optional(),
  productId: z.string().uuid().optional(),
  productIds: z.array(z.string().uuid()).max(50).optional(),
  orderId: z.string().trim().min(1).max(200).optional(),
  expectedAmount: z.union([z.string(), z.number()]).optional(),
  note: z.string().trim().max(1000).optional(),
  // Auditoría
  validationMode: z.enum(["AUTO", "MANUAL"]).optional(),
  matchScore: z.number().int().min(0).max(100).optional(),
  matchStrategy: z.string().trim().min(1).max(100).optional(),
  matchedPayerNameInput: z.string().trim().min(1).max(200).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

export const updateStatusQuerySchema = phoneQuerySchema;
export const updateStatusParamsSchema = z.object({ id: z.string().uuid() });

// POST /match
export const matchBodySchema = z.object({
  amountPaid: z.union([z.string(), z.number()]).optional(),
  payerName: z.string().trim().min(1).optional(),
  paymentSource: z.string().trim().min(1).optional(),
  occurredFrom: z.string().datetime().optional(),
  occurredTo: z.string().datetime().optional(),
  source: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

// POST /:id/claim
export const claimBodySchema = z.object({
  claimedBy: z.string().trim().min(1).max(200),
  claimTtlSeconds: z.number().int().min(5).max(600).optional(),
});

export type UpdateStatusBody = z.infer<typeof updateStatusBodySchema>;
export type MatchBody = z.infer<typeof matchBodySchema>;
export type ClaimBody = z.infer<typeof claimBodySchema>;
