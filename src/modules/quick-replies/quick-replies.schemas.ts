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

export const upsertQuickReplySchema = z.object({
  title: z.string().trim().min(1, "Título requerido").max(120),
  categoryId: z.string().uuid().nullable().optional(),
  messages: z.array(quickReplyMessageSchema).min(1, "Agrega al menos un mensaje").max(10),
});

export const upsertCategorySchema = z.object({
  name: z.string().trim().min(1, "Nombre requerido").max(60),
});

export const sendQuickReplySchema = z.object({
  conversationId: z.string().uuid(),
});
