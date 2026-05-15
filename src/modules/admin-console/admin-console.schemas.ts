import { z } from "zod";

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
  adminPhone: z.string().trim().regex(/^\+?\d{8,20}$/, "Ingresa un celular valido"),
  password: z.string().min(6),
  timezone: z.string().min(3).default("America/Lima"),
  isActive: z.boolean().default(true),
});

export const clientIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const updateClientStatusSchema = z.object({
  isActive: z.boolean(),
});
