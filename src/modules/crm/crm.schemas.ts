import { z } from "zod";

const COLOR = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "Color inválido (formato #RRGGBB)");

export const upsertCrmSchema = z.object({
  name: z.string().trim().min(1, "Nombre requerido").max(25),
  description: z.string().trim().max(60).optional().nullable(),
  color: COLOR.default("#6366f1"),
});

export const upsertColumnSchema = z.object({
  name: z.string().trim().min(1, "Nombre requerido").max(30),
  color: COLOR.optional().nullable(),
});

export const reorderColumnsSchema = z.object({
  columnIds: z.array(z.string().uuid()).min(1),
});

export const moveCardSchema = z.object({
  customerId: z.string().uuid(),
  // null => volver al Inbox (sin placement en este CRM)
  toColumnId: z.string().uuid().nullable(),
  position: z.number().int().min(0).optional(),
});

export const upsertTagSchema = z.object({
  name: z.string().trim().min(1, "Nombre requerido").max(30),
  color: COLOR.default("#22c55e"),
});

export const setCustomerTagsSchema = z.object({
  tagIds: z.array(z.string().uuid()).max(50),
});

export const upsertDealSchema = z.object({
  description: z.string().trim().min(1, "Descripción requerida").max(100),
  amount: z.coerce.number().positive("El valor debe ser mayor a 0").max(999999999),
});

// --- Acciones masivas ---
const customerIds = z.array(z.string().uuid()).min(1, "Selecciona al menos un lead").max(500);

export const bulkMoveSchema = z.object({
  customerIds,
  // null => volver al Inbox (quitar placement en este CRM)
  toColumnId: z.string().uuid().nullable(),
});

export const bulkTagsSchema = z
  .object({
    customerIds,
    addTagIds: z.array(z.string().uuid()).max(50).optional().default([]),
    removeTagIds: z.array(z.string().uuid()).max(50).optional().default([]),
  })
  .refine((d) => d.addTagIds.length > 0 || d.removeTagIds.length > 0, {
    message: "Indica al menos una etiqueta a asignar o quitar",
  });

export const bulkDealsSchema = z.object({
  customerIds,
  description: z.string().trim().max(100).optional().default(""),
  amount: z.coerce.number().positive("El valor debe ser mayor a 0").max(999999999),
});

export const bulkDeleteSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
});
