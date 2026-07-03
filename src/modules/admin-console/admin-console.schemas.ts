import { z } from "zod";
import { businessVerticalSchema } from "../business/business.schemas";

export const updateVerticalsSchema = z.object({
  enabledVerticals: z.array(businessVerticalSchema).min(1, "Debes habilitar al menos un rubro."),
});

export const superadminLoginSchema = z.object({
  phone: z.string().min(6).max(20),
  password: z.string().min(6).max(100),
});

export const createClientSchema = z.object({
  companyName: z.string().min(2),
  slug: z
    .string()
    .min(2)
    .regex(/^[a-z0-9-]+$/, "El slug solo puede tener minusculas, numeros y guiones"),
  adminName: z.string().min(2),
  adminEmail: z.string().trim().email("Ingresa un email valido"),
  adminPhone: z.string().trim().regex(/^\+?\d{8,20}$/, "Ingresa un celular valido"),
  password: z.string().min(6),
  timezone: z.string().min(3).default("America/Lima"),
  isActive: z.boolean().default(true),
  // Proveedor del canal WhatsApp. SMSTOOLS (default) aprovisiona la cuenta en
  // SMS Tools como siempre; META omite ese aprovisionamiento y acepta
  // credenciales opcionales (el tenant puede completarlas luego en /whatsapp).
  whatsappProvider: z.enum(["SMSTOOLS", "META"]).default("SMSTOOLS"),
  // Paquete inicial (opcional): crea la suscripción SaaS del tenant al crearlo.
  // Sin planId la empresa queda LEGACY (acceso libre sin límites).
  planId: z.string().uuid().optional(),
  planMonths: z.coerce.number().int().min(1).max(36).default(1),
  metaAccessToken: z.string().trim().optional(),
  metaPhoneNumberId: z.string().trim().regex(/^\d{5,20}$/, "El Phone Number ID son solo dígitos").optional(),
  metaWabaId: z.string().trim().regex(/^\d{5,20}$/, "El WABA ID son solo dígitos").optional(),
});

export const clientIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const updateClientStatusSchema = z.object({
  isActive: z.boolean(),
});

export const updateLandingSceneSchema = z.object({
  scene: z.string().min(2).max(40),
});
