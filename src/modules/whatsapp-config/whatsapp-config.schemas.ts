import { z } from "zod";

const noSpacesText = z.string().trim().min(1).regex(/^\S+$/, "No debe contener espacios");
const whatsappRecipient = z
  .string()
  .trim()
  .regex(/^\+?\d{8,15}$/, "Ingresa un numero valido en formato internacional. Ej. 51912345678");

export const upsertWhatsappConfigSchema = z.object({
  apiUrl: z.string().url(),
  secret: noSpacesText,
  account: noSpacesText,
  isActive: z.boolean().default(true),
});

export const testWhatsappConnectionSchema = z.object({
  apiUrl: z.string().url(),
  secret: noSpacesText,
  account: noSpacesText,
  recipient: whatsappRecipient,
  message: z.string().trim().min(3, "El mensaje de prueba es muy corto"),
});
