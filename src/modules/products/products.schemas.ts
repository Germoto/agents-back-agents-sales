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
  // Incluir en la presentación/info inicial del producto (envío bulk). Default true.
  showInPresentation: z.boolean().default(true),
});

export const productBodySchema = z.object({
  slug: z.string().min(1),
  active: z.boolean().default(true),
  showInCatalog: z.boolean().default(true),
  // Opcional: el backend lo deriva de Company.vertical. Para OTHER se respeta el enviado.
  productType: z.enum(["DIGITAL", "PHYSICAL"]).optional(),
  name: z.string().min(1),
  price: z.string().min(1),
  regularPrice: z.string().nullable().optional(),
  stock: z.coerce.number().int().nullable().optional(),
  shortDescription: z.string().min(1),
  // Opcional: varios rubros (restaurante/streaming) no usan descripción completa.
  fullDescription: z.string().optional().default(""),
  presentationMessage: z.string().nullable().optional(),
  deliveryMethod: z.string().nullable().optional(),
  support: z.string().nullable().optional(),
  // Atributos flexibles por rubro (clave→valor). Ej. restaurante: {ingredientes, tiempo_preparacion};
  // streamer: {duracion_suscripcion}; servicio: {duracion, modalidad}.
  attributes: z.record(z.string(), z.string()).nullable().optional(),
  category: z.string().nullable().optional(),
  // Datos del vertical pack (estructura depende del rubro). Validación laxa aquí;
  // la UI construye la forma correcta según Company.vertical.
  verticalData: z.record(z.string(), z.unknown()).nullable().optional(),
  // Override de recordatorios por producto y tipo: { <tipo>: { message?, mediaUrl? } }.
  reminderConfig: z.record(z.string(), z.unknown()).nullable().optional(),
  // Orden ya NO se teclea: en create se auto-asigna (append) y en la lista se reordena
  // arrastrando. Opcional para compat.
  sortOrder: z.coerce.number().int().min(0).optional(),
  aliases: z.array(z.string().min(1)).default([]),
  benefits: z.array(orderedValueSchema).default([]),
  includes: z.array(orderedValueSchema).default([]),
  bonuses: z.array(orderedValueSchema).default([]),
  faqs: z.array(qaSchema).default([]),
  objections: z.array(qaSchema).default([]),
  files: z.array(productFileSchema).default([]),
  // Tolerante al registrar (se puede guardar borrador sin link); el requisito real
  // para INFOPRODUCT/STREAMER es rubro-aware en bot.service.buildBotConfig.
  digitalDelivery: z.object({
    link: z.string().optional().default(""),
    instructions: z.string().optional().default(""),
    // Mensajes adicionales opcionales tras la entrega (cada uno media + texto) y cross-sell.
    followupMessages: z
      .array(
        z.object({
          message: z.string().optional().default(""),
          mediaUrl: z.string().optional().default(""),
          mediaType: z.string().optional().default(""),
        }),
      )
      .optional()
      .default([]),
    // Legacy single (compat; el front ya no los envía).
    followupMessage: z.string().optional().default(""),
    followupMediaUrl: z.string().optional().default(""),
    followupMediaType: z.string().optional().default(""),
    crossSellProductId: z.string().uuid().nullable().optional(),
    crossSellPitch: z.string().optional().default(""),
    crossSellPitchMediaUrl: z.string().optional().default(""),
    crossSellPitchMediaType: z.string().optional().default(""),
    // Acciones al cerrar la venta: mover al cliente a una pestaña del CRM y/o etiquetar.
    onSaleCrmId: z.string().uuid().nullable().optional(),
    onSaleCrmColumnId: z.string().uuid().nullable().optional(),
    onSaleTagIds: z.array(z.string().uuid()).optional().default([]),
  }).nullable().optional(),
  physicalDelivery: z.object({
    requiresAddress: z.boolean().default(true),
    deliveryCost: z.string().nullable().optional(),
    deliveryTime: z.string().nullable().optional(),
    pickupAvailable: z.boolean().default(false),
    deliveryAreas: z.array(z.string().min(1)).default([]),
  }).nullable().optional(),
  variants: z.array(productVariantSchema).default([]),
});
// Nota: el requisito de entrega (digital/físico) ya no se valida aquí; pasa a ser
// rubro-aware en bot.service.buildBotConfig (restaurante usa entrega del negocio,
// servicio no requiere entrega, etc.).

export const productIdParamsSchema = z.object({
  id: z.string().uuid(),
});
