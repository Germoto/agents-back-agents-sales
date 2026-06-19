import { z } from "zod";

export const updateCustomerSchema = z.object({
  // El número del chat se puede corregir (a veces el gateway entrega un número mal).
  // Se normaliza y valida en el servicio. No nullable: un contacto siempre tiene número.
  phone: z.string().trim().max(24).optional(),
  name: z.string().trim().max(120).nullable().optional(),
  email: z.string().trim().max(160).nullable().optional(),
  sexo: z.string().trim().max(20).nullable().optional(),
  fechaNacimiento: z.string().trim().nullable().optional(),
  idioma: z.string().trim().max(40).nullable().optional(),
  origenDeLead: z.string().trim().max(40).nullable().optional(),
  selectedProductId: z.string().uuid().nullable().optional(),
});

export const createNoteSchema = z.object({
  text: z.string().trim().max(4000).nullable().optional(),
  mediaUrl: z.string().trim().max(2000).nullable().optional(),
  mediaType: z.enum(["image", "video", "audio", "document"]).nullable().optional(),
  conversationId: z.string().uuid().nullable().optional(),
});
