import { z } from "zod";

// Login por celular O usuario en el mismo campo. `phone` queda como alias
// legacy del frontend anterior (compat entre deploys).
export const loginSchema = z
  .object({
    identifier: z.string().trim().min(4).max(30).optional(),
    phone: z.string().trim().min(4).max(30).optional(),
    password: z.string().min(6).max(100),
  })
  .refine((v) => Boolean(v.identifier || v.phone), { message: "Ingresa tu celular o usuario" });

export const updateUiThemeSchema = z.object({
  mode: z.enum(["dark", "light"]),
  accentFrom: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  accentTo: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  preset: z.string().max(40).optional(),
});
