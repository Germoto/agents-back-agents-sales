import { z } from "zod";

/** Alta de sesión del visitante (pre-chat del widget). */
export const createSessionSchema = z.object({
  token: z.string().trim().min(8).max(80),
  name: z.string().trim().max(80).optional(),
  /** WhatsApp opcional: si lo da, se une al MISMO cliente del canal WhatsApp. */
  phone: z.string().trim().max(25).optional(),
  /** Origin de la página que EMBEBE el widget (document.referrer del iframe). */
  parentOrigin: z.string().trim().max(300).optional(),
});

export const postMessageSchema = z.object({
  message: z.string().trim().min(1).max(2000),
});

/** Config del panel (Chat Web). */
export const updateWebchatConfigSchema = z.object({
  enabled: z.boolean().optional(),
  allowedOrigins: z
    .array(z.string().trim().min(1).max(150))
    .max(20)
    .optional(),
  welcomeMessage: z.string().trim().max(500).optional(),
  accentColor: z
    .string()
    .trim()
    .max(20)
    .regex(/^$|^#[0-9a-fA-F]{3,8}$/, "Color inválido (usa formato #rrggbb)")
    .optional(),
});

export type CreateSessionInput = z.infer<typeof createSessionSchema>;
export type UpdateWebchatConfigInput = z.infer<typeof updateWebchatConfigSchema>;
