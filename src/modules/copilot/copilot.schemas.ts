import { z } from "zod";

/**
 * Copiloto de configuración (Fase 1: productos + visión). El historial viaja
 * completo desde el cliente; las imágenes ya están subidas (/product-files) y
 * llegan como URLs públicas.
 */
export const copilotChatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(6000),
        imageUrls: z.array(z.string().url().max(2000)).max(3).optional(),
      }),
    )
    .min(1)
    .max(30)
    .refine((msgs) => msgs[msgs.length - 1]?.role === "user", "El último mensaje debe ser del usuario"),
});
