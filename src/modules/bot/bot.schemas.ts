import { z } from "zod";

export const botConfigQuerySchema = z.object({
  channel: z.literal("whatsapp"),
  account: z.string().min(1).optional(),
  phone: z
    .string()
    .trim()
    .regex(/^\+?\d{6,20}$/, "El phone debe tener solo digitos y opcionalmente + al inicio"),
});
