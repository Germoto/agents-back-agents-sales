import { z } from "zod";

const reminderSchema = z
  .object({
    enabled: z.boolean().optional(),
    daysBefore: z.coerce.number().int().min(0).max(60).optional(),
    message: z.string().nullable().optional(),
    mediaUrl: z.string().nullable().optional(),
    mediaType: z.string().nullable().optional(),
  })
  .optional();

export const createSubscriptionSchema = z
  .object({
    customerPhone: z.string().optional(),
    customerId: z.string().uuid().optional(),
    customerName: z.string().nullable().optional(),
    productId: z.string().uuid().nullable().optional(),
    productName: z.string().nullable().optional(),
    planLabel: z.string().nullable().optional(),
    startAt: z.string().nullable().optional(),
    expiresAt: z.string().nullable().optional(),
    durationDays: z.coerce.number().int().min(1).max(3650).nullable().optional(),
    amount: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    reminder: reminderSchema,
  })
  .refine((d) => d.customerPhone?.trim() || d.customerId, { message: "Falta el cliente (teléfono o id)", path: ["customerPhone"] })
  .refine((d) => d.expiresAt || d.durationDays, { message: "Indica vencimiento o duración en días", path: ["durationDays"] });

export const listSubscriptionsQuerySchema = z.object({
  status: z.enum(["ACTIVE", "EXPIRED", "RENEWED", "CANCELLED"]).optional(),
  filter: z.enum(["due", "expired", "active"]).optional(),
  productId: z.string().uuid().optional(),
  q: z.string().optional(),
  daysAhead: z.coerce.number().int().min(1).max(365).optional(),
});

export const subscriptionIdParamsSchema = z.object({ id: z.string().uuid() });

export const markRenewedSchema = z.object({ reminder: reminderSchema }).optional();
