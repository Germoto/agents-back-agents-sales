import { z } from "zod";

const noSpacesText = z.string().trim().min(1).regex(/^\S+$/, "No debe contener espacios");
const whatsappRecipient = z
  .string()
  .trim()
  .regex(/^\+?\d{8,15}$/, "Ingresa un numero valido en formato internacional. Ej. 51912345678");

export const upsertWhatsappConfigSchema = z.object({
  apiUrl: z.string().url(),
  secret: noSpacesText,
  account: noSpacesText.nullable().optional(),
  isActive: z.boolean().default(true),
  defaultServerId: z.number().int().positive().nullable().optional(),
});

// Cambio explícito del proveedor activo del canal (SMS Tools ⇄ Meta), sin
// tocar credenciales. Reemplaza el "selector implícito" de guardar cada form.
export const setProviderSchema = z.object({
  provider: z.enum(["SMSTOOLS", "META"]),
});

export const testWhatsappConnectionSchema = z.object({
  apiUrl: z.string().url(),
  secret: noSpacesText,
  account: noSpacesText,
  recipient: whatsappRecipient,
  message: z.string().trim().min(3, "El mensaje de prueba es muy corto"),
});

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const linkSchema = z.object({
  sid: z.number().int().positive().optional(),
});

export const relinkSchema = z.object({
  unique: noSpacesText,
  sid: z.number().int().positive().optional(),
});

export const tokenQuerySchema = z.object({
  token: z.string().min(8),
});

// Credenciales de la API oficial de Meta (Cloud API). accessToken vacío/omitido
// conserva el token ya guardado (el panel lo muestra enmascarado).
export const updateMetaConfigSchema = z.object({
  accessToken: z.string().trim().nullable().optional(),
  phoneNumberId: z.string().trim().regex(/^\d{5,20}$/, "El Phone Number ID de Meta son solo dígitos"),
  wabaId: z.string().trim().regex(/^\d{5,20}$/, "El WABA ID son solo dígitos").nullable().optional().or(z.literal("").transform(() => null)),
  isActive: z.boolean().default(true),
});

