import { z } from "zod";

export const createWebhookEndpointSchema = z.object({
  source: z.string().min(1).max(64),
  secret: z.string().min(8).max(512),
  description: z.string().max(280).optional(),
  autoApprove: z.boolean().optional(),
});

export const updateWebhookEndpointSchema = z.object({
  active: z.boolean().optional(),
  autoApprove: z.boolean().optional(),
  description: z.string().max(280).optional(),
});

export type CreateWebhookEndpointDto = z.infer<typeof createWebhookEndpointSchema>;
export type UpdateWebhookEndpointDto = z.infer<typeof updateWebhookEndpointSchema>;

export const idParamsSchema = z.object({ id: z.string().min(1) });
