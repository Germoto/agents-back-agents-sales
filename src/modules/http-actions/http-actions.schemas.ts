import { z } from "zod";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export const HTTP_AUTH_TYPES = ["NONE", "BEARER", "HEADER", "QUERY", "BASIC"] as const;
export const HTTP_BODY_TYPES = ["NONE", "JSON", "FORM", "RAW"] as const;

export const kvListSchema = z
  .array(
    z.object({
      key: z.string().trim().min(1, "Nombre requerido").max(100),
      value: z.string().max(4000).default(""),
    }),
  )
  .max(20, "Máximo 20 entradas");

export const responseVarSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,30}$/, "Usa minúsculas, números y _ (ej. api, demo)");

const headersMapSchema = z.record(z.string().trim().min(1).max(100), z.string().max(4000)).refine((m) => Object.keys(m).length <= 20, {
  message: "Máximo 20 cabeceras",
});

export const createConnectionSchema = z.object({
  name: z.string().trim().min(2, "Ingresa un nombre").max(80),
  baseUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === "" || /^https:\/\/[^\s]+$/i.test(v), "La URL base debe empezar con https://"),
  authType: z.enum(HTTP_AUTH_TYPES).default("NONE"),
  authName: z.string().trim().max(100).optional().nullable(),
  /** Secreto en claro: se cifra al guardar. */
  authSecret: z.string().max(4000).optional().nullable(),
  headers: headersMapSchema.optional().default({}),
  timeoutMs: z.coerce.number().int().min(1000).max(30000).optional().default(15000),
});
export type CreateConnectionDto = z.infer<typeof createConnectionSchema>;

export const updateConnectionSchema = createConnectionSchema.partial();
export type UpdateConnectionDto = z.infer<typeof updateConnectionSchema>;

export const agentParamsSchema = z
  .array(
    z.object({
      name: z.string().trim().regex(/^[a-z][a-z0-9_]{0,30}$/, "Nombre en minúsculas sin espacios (ej. correo)"),
      description: z.string().trim().max(200).default(""),
      required: z.boolean().default(true),
    }),
  )
  .max(8, "Máximo 8 parámetros");

/** Petición "inline" (igual que una acción, sin nombre): la usa el bloque de flujo y el test sin guardar. */
export const httpRequestSchema = z.object({
  connectionId: z.string().uuid().optional().nullable(),
  method: z.enum(HTTP_METHODS).default("POST"),
  url: z.string().trim().min(1, "Ingresa la URL").max(2000),
  query: kvListSchema.optional().default([]),
  headers: kvListSchema.optional().default([]),
  bodyType: z.enum(HTTP_BODY_TYPES).default("JSON"),
  body: z.string().max(16_000).optional().nullable(),
  responseVar: responseVarSchema.optional().default("api"),
  retries: z.coerce.number().int().min(0).max(2).optional().default(1),
});
export type HttpRequestDto = z.infer<typeof httpRequestSchema>;

export const createActionSchema = httpRequestSchema.extend({
  name: z.string().trim().min(2, "Ingresa un nombre").max(80),
  description: z.string().trim().max(500).optional().nullable(),
  agentEnabled: z.boolean().optional().default(false),
  agentDescription: z.string().trim().max(600).optional().nullable(),
  agentParams: agentParamsSchema.optional().default([]),
  oncePerCustomer: z.boolean().optional().default(false),
  agentResultHint: z.string().trim().max(400).optional().nullable(),
});
export type CreateActionDto = z.infer<typeof createActionSchema>;

export const updateActionSchema = createActionSchema.partial();
export type UpdateActionDto = z.infer<typeof updateActionSchema>;

export const idParamsSchema = z.object({ id: z.string().uuid() });

export const testVarsSchema = z.object({
  vars: z.record(z.string(), z.string().max(4000)).optional().default({}),
});

export const testInlineSchema = z.object({
  request: httpRequestSchema,
  vars: z.record(z.string(), z.string().max(4000)).optional().default({}),
});

export const listRunsQuerySchema = z.object({
  actionId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});
