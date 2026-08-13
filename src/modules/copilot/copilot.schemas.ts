import { z } from "zod";

/**
 * Copiloto de configuración (Fase 1: productos + visión). El historial viaja
 * completo desde el cliente; las imágenes ya están subidas (/product-files) y
 * llegan como URLs públicas.
 */
const attachmentSchema = z.object({
  url: z.string().url().max(2000),
  storagePath: z.string().max(500),
  originalName: z.string().max(255),
  extension: z.string().max(20),
  mimeType: z.string().max(100),
  size: z.number().int().min(0),
  type: z.enum(["IMAGE", "PDF", "VIDEO", "AUDIO", "OTHER"]),
});

export const copilotChatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(6000),
        // Adjuntos con metadata completa (para visión Y para dejarlos como fotos de producto).
        attachments: z.array(attachmentSchema).max(3).optional(),
        // Legado (chats en vuelo previos al cambio): solo URLs para visión.
        imageUrls: z.array(z.string().url().max(2000)).max(3).optional(),
      }),
    )
    .min(1)
    .max(30)
    .refine((msgs) => msgs[msgs.length - 1]?.role === "user", "El último mensaje debe ser del usuario"),
});
