import { z } from "zod";
import { usernameSchema } from "../../lib/identifier";

// ---------------------------------------------------------------------------
// Pre-registro público del landing. La contraseña se valida con la política
// completa (el checklist del frontend es espejo exacto de estas reglas).
// ---------------------------------------------------------------------------

export const passwordPolicySchema = z
  .string()
  .min(8, "Mínimo 8 caracteres")
  .max(100)
  .regex(/[A-Z]/, "Debe incluir una mayúscula")
  .regex(/[a-z]/, "Debe incluir una minúscula")
  .regex(/[0-9]/, "Debe incluir un número")
  .regex(/[^A-Za-z0-9]/, "Debe incluir un símbolo (ej. * . - _ @)");

export const createPreRegistrationSchema = z.object({
  planId: z.string().uuid().optional(),
  companyName: z.string().trim().min(2, "Ingresa el nombre de tu negocio").max(80),
  fullName: z.string().trim().min(2, "Ingresa tu nombre").max(80),
  email: z.string().trim().toLowerCase().email("Correo inválido"),
  countryCode: z.string().trim().regex(/^\+\d{1,4}$/, "Código de país inválido"),
  phone: z.string().trim().regex(/^\d{6,15}$/, "Solo dígitos, sin el código de país"),
  username: usernameSchema,
  password: passwordPolicySchema,
});

export const verifyCodeSchema = z.object({
  code: z.string().regex(/^\d{6}$/, "Código de 6 dígitos"),
});

export const preRegIdParamsSchema = z.object({
  id: z.string().uuid(),
});
