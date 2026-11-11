import { z } from "zod";

export const searchAgenciesQuerySchema = z.object({
  q: z.string().trim().max(120).default(""),
  courier: z.string().trim().max(30).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});
