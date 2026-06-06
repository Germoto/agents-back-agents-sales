import { z } from "zod";

// Config de recordatorios/seguimientos que consume el agente y el scheduler.
export const followupConfigSchema = z
  .object({
    abandonedCartHours: z.coerce.number().min(0).max(720).optional(),
    leftOnReadMinutes: z.coerce.number().min(0).max(10080).optional(),
    offerCountdownHours: z.coerce.number().min(0).max(720).optional(),
  })
  .nullable()
  .optional();

export const upsertAgentConfigSchema = z.object({
  openaiModel: z.string().min(1).default("gpt-4o-mini"),
  openaiApiKey: z.string().min(1, "openaiApiKey es obligatoria"),
  temperature: z.coerce.number().min(0).max(2).default(0.25),
  basePrompt: z.string().min(1),
  salesStyle: z.string().min(1),
  rules: z.array(z.string().min(1)).default([]),
  followupConfig: followupConfigSchema,
  // Modo de respuesta: OPEN responde a todos; ALLOWLIST solo a testNumbers (prueba).
  replyMode: z.enum(["OPEN", "ALLOWLIST"]).default("OPEN"),
  testNumbers: z.array(z.string().min(1)).default([]),
});
