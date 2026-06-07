import { z } from "zod";

// Plantilla de recordatorio por tipo: activar, demora (min), texto e imagen.
const reminderTemplateSchema = z
  .object({
    enabled: z.boolean().optional(),
    delayMinutes: z.coerce.number().min(1).max(100000).optional(),
    message: z.string().optional(),
    mediaUrl: z.string().nullable().optional(),
  })
  .optional();

// Config de recordatorios/seguimientos que consume el agente y el scheduler.
// Forma nueva: por tipo. Se mantiene laxa para compatibilidad con datos viejos.
export const followupConfigSchema = z
  .object({
    abandonedCart: reminderTemplateSchema,
    leftOnRead: reminderTemplateSchema,
    offerCountdown: reminderTemplateSchema,
    postSale: reminderTemplateSchema,
    // compat: campos viejos (se ignoran si vienen los nuevos)
    abandonedCartHours: z.coerce.number().optional(),
    leftOnReadMinutes: z.coerce.number().optional(),
    offerCountdownHours: z.coerce.number().optional(),
  })
  .nullable()
  .optional();

// Núcleo de Agente IA (modelo + prompt). Recordatorios y modo de respuesta se
// guardan por separado (módulos Recordatorios y Pruebas) para no pisarlos.
export const coreAgentConfigSchema = z.object({
  openaiModel: z.string().min(1).default("gpt-4o-mini"),
  openaiApiKey: z.string().min(1, "openaiApiKey es obligatoria"),
  temperature: z.coerce.number().min(0).max(2).default(0.25),
  basePrompt: z.string().min(1),
  salesStyle: z.string().min(1),
  rules: z.array(z.string().min(1)).default([]),
});

// PUT /agent-config/reminders — solo followupConfig.
export const remindersConfigSchema = z.object({
  followupConfig: followupConfigSchema,
});

// PUT /agent-config/reply-mode — solo modo de respuesta (módulo Pruebas).
export const replyModeConfigSchema = z.object({
  replyMode: z.enum(["OPEN", "ALLOWLIST"]).default("OPEN"),
  testNumbers: z.array(z.string().min(1)).default([]),
});
