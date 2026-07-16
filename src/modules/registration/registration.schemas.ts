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

// ---------------------------------------------------------------------------
// Consola superadmin: edición y conversión de pre-registros.
// ---------------------------------------------------------------------------

export const businessVerticalSchema = z.enum([
  "INFOPRODUCT",
  "PHYSICAL_GOODS",
  "RESTAURANT",
  "STREAMER",
  "SERVICE",
  "OTHER",
]);

export const listPreRegistrationsQuerySchema = z.object({
  status: z.enum(["EMAIL_PENDING", "VERIFIED", "CONVERTED", "REJECTED"]).optional(),
});

export const updatePreRegistrationAdminSchema = z.object({
  planId: z.string().uuid().nullable().optional(),
  vertical: businessVerticalSchema.optional(),
  companyName: z.string().trim().min(2).max(80).optional(),
  fullName: z.string().trim().min(2).max(80).optional(),
  email: z.string().trim().toLowerCase().email().optional(),
  countryCode: z.string().trim().regex(/^\+\d{1,4}$/).optional(),
  phone: z.string().trim().regex(/^\d{6,20}$/).optional(),
  username: usernameSchema.optional(),
  adminNotes: z.string().trim().max(500).nullable().optional(),
});

export const convertPreRegistrationSchema = z.object({
  slug: z
    .string()
    .min(2, "Ingresa un slug")
    .regex(/^[a-z0-9-]+$/, "Usa solo minusculas, numeros y guiones"),
  planMonths: z.coerce.number().int().min(1).max(36).default(1),
  whatsappProvider: z.enum(["SMSTOOLS", "META"]).default("SMSTOOLS"),
  isActive: z.boolean().default(true),
  metaAccessToken: z.string().trim().optional(),
  metaPhoneNumberId: z.string().trim().regex(/^\d{5,20}$/).optional(),
  metaWabaId: z.string().trim().regex(/^\d{5,20}$/).optional(),
});

export const rejectPreRegistrationSchema = z.object({
  reason: z.string().trim().max(300).optional(),
});
