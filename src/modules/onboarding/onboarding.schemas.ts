import { z } from "zod";

export const updateOnboardingSchema = z.object({
  step: z.number().int().min(1).max(4).optional(),
  draft: z.record(z.string(), z.unknown()).nullable().optional(),
  skipped: z.boolean().optional(),
  fullMenu: z.boolean().optional(),
  completed: z.boolean().optional(),
  restart: z.boolean().optional(),
});
