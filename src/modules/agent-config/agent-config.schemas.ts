import { z } from "zod";

export const upsertAgentConfigSchema = z.object({
  openaiModel: z.string().min(1).default("gpt-4o-mini"),
  openaiApiKey: z.string().min(1, "openaiApiKey es obligatoria"),
  temperature: z.coerce.number().min(0).max(2).default(0.25),
  basePrompt: z.string().min(1),
  salesStyle: z.string().min(1),
  rules: z.array(z.string().min(1)).default([]),
});
