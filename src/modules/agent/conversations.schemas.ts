import { z } from "zod";

/** Query de GET /agent/conversations (lista paginada del visor). */
export const conversationsQuerySchema = z.object({
  q: z.string().trim().max(80).default(""),
  /** Etapa del embudo (NUEVO, INTERESADO, …) o HUMANO / NO_CONTACTAR. */
  status: z.string().trim().max(40).default(""),
  tagId: z.string().uuid().optional(),
  adSourceId: z.string().trim().max(80).optional(),
  sortBy: z.enum(["last", "opened"]).default("last"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Query de GET /agent/conversations/:id/messages (tramos hacia atrás). */
export const messagesQuerySchema = z.object({
  /** ISO del createdAt más viejo ya cargado: devuelve los anteriores. */
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60),
});
