import { z } from "zod";
import { passwordPolicySchema } from "../registration/registration.schemas";

// Login por celular O usuario en el mismo campo. `phone` queda como alias
// legacy del frontend anterior (compat entre deploys).
export const loginSchema = z
  .object({
    identifier: z.string().trim().min(4).max(30).optional(),
    phone: z.string().trim().min(4).max(30).optional(),
    password: z.string().min(6).max(100),
  })
  .refine((v) => Boolean(v.identifier || v.phone), { message: "Ingresa tu celular o usuario" });

// Recuperación de contraseña (código de 6 dígitos al correo registrado).
export const requestResetSchema = z.object({
  identifier: z.string().trim().min(4).max(80),
});

export const confirmResetSchema = z.object({
  id: z.string().uuid(),
  code: z.string().regex(/^\d{6}$/, "Código de 6 dígitos"),
  newPassword: passwordPolicySchema,
});

// Cambio de contraseña con sesión activa.
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(6).max(100),
  newPassword: passwordPolicySchema,
});

export const updateUiThemeSchema = z.object({
  mode: z.enum(["dark", "light"]),
  accentFrom: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  accentTo: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  preset: z.string().max(40).optional(),
  // Fondo del chat de Conversaciones (color + doodles estilo WhatsApp).
  chatBg: z
    .object({
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      doodles: z.boolean(),
    })
    .nullable()
    .optional(),
});
