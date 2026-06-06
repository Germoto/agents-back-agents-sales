import { z } from "zod";

const orderedValueSchema = z.object({
  value: z.string().min(1),
  sortOrder: z.coerce.number().int().min(0),
});

const qaSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  sortOrder: z.coerce.number().int().min(0),
});

const productVariantSchema = z.object({
  name: z.string().min(1),
  options: z.array(z.string().min(1)).default([]),
  sortOrder: z.coerce.number().int().min(0).default(0),
});

const productFileSchema = z.object({
  id: z.string().uuid().optional(),
  type: z.enum(["IMAGE", "PDF", "VIDEO", "AUDIO", "OTHER"]),
  url: z.string().min(1),
  storagePath: z.string().min(1),
  originalName: z.string().default(""),
  extension: z.string().default(""),
  mimeType: z.string().default(""),
  size: z.coerce.number().int().min(0).default(0),
  description: z.string().default(""),
  sortOrder: z.coerce.number().int().min(0).default(0),
});

export const productBodySchema = z.object({
  slug: z.string().min(1),
  active: z.boolean().default(true),
  productType: z.enum(["DIGITAL", "PHYSICAL"]),
  name: z.string().min(1),
  price: z.string().min(1),
  regularPrice: z.string().nullable().optional(),
  stock: z.coerce.number().int().nullable().optional(),
  shortDescription: z.string().min(1),
  fullDescription: z.string().min(1),
  deliveryMethod: z.string().nullable().optional(),
  support: z.string().nullable().optional(),
  // Atributos flexibles por rubro (clave→valor). Ej. restaurante: {ingredientes, tiempo_preparacion};
  // streamer: {duracion_suscripcion}; servicio: {duracion, modalidad}.
  attributes: z.record(z.string(), z.string()).nullable().optional(),
  category: z.string().nullable().optional(),
  // Datos del vertical pack (estructura depende del rubro). Validación laxa aquí;
  // la UI construye la forma correcta según Company.vertical.
  verticalData: z.record(z.string(), z.unknown()).nullable().optional(),
  sortOrder: z.coerce.number().int().min(0).default(0),
  aliases: z.array(z.string().min(1)).default([]),
  benefits: z.array(orderedValueSchema).default([]),
  includes: z.array(orderedValueSchema).default([]),
  bonuses: z.array(orderedValueSchema).default([]),
  faqs: z.array(qaSchema).default([]),
  objections: z.array(qaSchema).default([]),
  files: z.array(productFileSchema).default([]),
  digitalDelivery: z.object({
    link: z.string().url(),
    instructions: z.string().min(1),
  }).nullable().optional(),
  physicalDelivery: z.object({
    requiresAddress: z.boolean().default(true),
    deliveryCost: z.string().nullable().optional(),
    deliveryTime: z.string().nullable().optional(),
    pickupAvailable: z.boolean().default(false),
    deliveryAreas: z.array(z.string().min(1)).default([]),
  }).nullable().optional(),
  variants: z.array(productVariantSchema).default([]),
}).superRefine((data, ctx) => {
  if (data.productType === "DIGITAL" && !data.digitalDelivery?.link) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Un producto digital debe tener digitalDelivery.link",
      path: ["digitalDelivery", "link"],
    });
  }

  if (data.productType === "PHYSICAL" && !data.physicalDelivery) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Un producto fisico debe tener physicalDelivery",
      path: ["physicalDelivery"],
    });
  }
});

export const productIdParamsSchema = z.object({
  id: z.string().uuid(),
});
