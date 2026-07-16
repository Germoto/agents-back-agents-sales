import { z } from "zod";

export const businessVerticalSchema = z.enum([
  "INFOPRODUCT",
  "PHYSICAL_GOODS",
  "RESTAURANT",
  "STREAMER",
  "SERVICE",
  "OTHER",
]);

export const deliveryConfigSchema = z
  .object({
    cost: z.string().nullable().optional(),
    time: z.string().nullable().optional(),
    areas: z.array(z.string()).default([]),
    pickupAvailable: z.boolean().default(false),
    requiresAddress: z.boolean().default(true),
  })
  .nullable()
  .optional();

export const updateBusinessSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  adminPhone: z.string().min(6),
  vertical: businessVerticalSchema.default("INFOPRODUCT"),
  timezone: z.string().min(1).default("America/Lima"),
  // Modo de operación del bot: agente IA abierto o chatbot de flujos guiados.
  botMode: z.enum(["AI", "FLOW"]).default("AI"),
  isActive: z.boolean().default(true),
  deliveryConfig: deliveryConfigSchema,
  // Firma anexada a los mensajes automáticos (agente IA + flujos).
  firmaEnabled: z.boolean().default(false),
  firmaText: z.string().trim().max(60).nullable().optional(),
  // Pausa entre mensajes consecutivos del bot (presentación, multimedia, entrega,
  // bloques de flujo). Desactivada = ritmo estándar (~1s).
  messageGapEnabled: z.boolean().optional(),
  messageGapSeconds: z.coerce.number().int().min(1).max(30).optional(),
});
