import { z } from "zod";

/** Mensaje de la acción send-message (mismo shape que QuickReply.messages). */
const campaignMessageSchema = z
  .object({
    type: z.enum(["text", "image", "video", "audio", "document"]),
    text: z.string().trim().max(4000).optional(),
    mediaUrl: z.string().trim().url().optional(),
    fileName: z.string().trim().max(255).optional(),
  })
  .refine((m) => (m.type === "text" ? Boolean(m.text) : Boolean(m.mediaUrl)), {
    message: "Los mensajes de texto requieren texto; los multimedia requieren mediaUrl",
  });

/** Una acción de la secuencia de la campaña (discriminada por `type`). */
const campaignActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("send-message"),
    messages: z.array(campaignMessageSchema).min(1, "Agrega al menos un mensaje").max(10),
  }),
  z.object({
    type: z.literal("wait"),
    seconds: z.coerce.number().int().min(1).max(3600),
  }),
  z.object({
    type: z.literal("tag"),
    addTagIds: z.array(z.string().uuid()).max(20).optional(),
    removeTagIds: z.array(z.string().uuid()).max(20).optional(),
  }),
  z.object({
    type: z.literal("crm-move"),
    crmId: z.string().uuid(),
    columnId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("handoff"),
    notifyOwner: z.boolean().optional().default(false),
  }),
]);

const sendConfigSchema = z.object({
  intervalSec: z.coerce.number().int().min(0).max(3600).default(10),
  pauseEvery: z.coerce.number().int().min(0).max(10000).default(10),
  pauseSec: z.coerce.number().int().min(0).max(86400).default(60),
  excludeMuted: z.boolean().default(true),
});

const audienceRecipientSchema = z.object({
  customerId: z.string().uuid().nullable().optional(),
  phone: z.string().trim().min(1).max(40),
  name: z.string().trim().max(160).nullable().optional(),
});

const audienceSchema = z.object({
  recipients: z.array(audienceRecipientSchema).max(50000).default([]),
});

export const createCampaignSchema = z.object({
  name: z.string().trim().min(1, "Nombre requerido").max(120),
});

export const updateCampaignSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  actions: z.array(campaignActionSchema).max(50).optional(),
  sendConfig: sendConfigSchema.optional(),
  audience: audienceSchema.optional(),
  contextProductId: z.string().uuid().nullable().optional(),
  contextTagIds: z.array(z.string().uuid()).max(20).optional(),
});

export const campaignIdParamsSchema = z.object({ id: z.string().uuid() });

export const testCampaignSchema = z.object({
  phone: z.string().trim().min(6, "Teléfono inválido").max(40),
  name: z.string().trim().max(160).optional(),
});

export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;
export type UpdateCampaignInput = z.infer<typeof updateCampaignSchema>;
