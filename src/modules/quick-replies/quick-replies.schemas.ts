import { z } from "zod";

/** Un mensaje de la secuencia: texto puro o multimedia con caption opcional. */
export const quickReplyMessageSchema = z
  .object({
    type: z.enum(["text", "image", "video", "audio", "document"]),
    text: z.string().trim().max(4000).optional(),
    mediaUrl: z.string().trim().url().optional(),
    fileName: z.string().trim().max(255).optional(),
  })
  .refine((m) => (m.type === "text" ? Boolean(m.text) : Boolean(m.mediaUrl)), {
    message: "Los mensajes de texto requieren texto; los multimedia requieren mediaUrl",
  });

export type QuickReplyMessageInput = z.infer<typeof quickReplyMessageSchema>;

/** Acciones que se ejecutan tras enviar la respuesta rápida. */
export const quickReplyActionsSchema = z.object({
  // Etiquetas internas que se le AÑADEN al cliente
  tagIds: z.array(z.string().uuid()).max(20).default([]),
  // Mover al cliente a una pestaña de un CRM (ambos o ninguno)
  crmId: z.string().uuid().nullable().optional(),
  crmColumnId: z.string().uuid().nullable().optional(),
});

export type QuickReplyActionsInput = z.infer<typeof quickReplyActionsSchema>;

export const upsertQuickReplySchema = z.object({
  title: z.string().trim().min(1, "Título requerido").max(120),
  // Comando para invocarla desde el input con "/": opcional, se normaliza en el service.
  command: z.string().trim().max(40).nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  messages: z.array(quickReplyMessageSchema).min(1, "Agrega al menos un mensaje").max(10),
  actions: quickReplyActionsSchema.nullable().optional(),
});

export const upsertCategorySchema = z.object({
  name: z.string().trim().min(1, "Nombre requerido").max(60),
});

export const sendQuickReplySchema = z.object({
  conversationId: z.string().uuid(),
});
