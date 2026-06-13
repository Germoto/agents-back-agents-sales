import { z } from "zod";

// Un mensaje (step) de la secuencia: demora (seg) + texto + multimedia.
const reminderStepSchema = z.object({
  delaySeconds: z.coerce.number().min(1).max(100000000),
  message: z.string().optional().default(""),
  mediaUrl: z.string().nullable().optional(),
  mediaType: z.string().optional().default(""),
});

// Secuencia de recordatorios por tipo: activar + varios mensajes. Se mantiene laxa
// (campos legacy opcionales) para compatibilidad con datos viejos.
const reminderSequenceSchema = z
  .object({
    enabled: z.boolean().optional(),
    steps: z.array(reminderStepSchema).optional(),
    // legacy (un solo mensaje): se normaliza a 1 step al resolver
    delayMinutes: z.coerce.number().optional(),
    message: z.string().optional(),
    mediaUrl: z.string().nullable().optional(),
  })
  .optional();

// Config de recordatorios/seguimientos que consume el agente y el scheduler.
export const followupConfigSchema = z
  .object({
    abandonedCart: reminderSequenceSchema,
    leftOnRead: reminderSequenceSchema,
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

// PUT /agent-config/muted-numbers — números en atención humana forzada.
// Límite alto para permitir importaciones masivas desde Excel/CSV.
export const mutedNumbersConfigSchema = z.object({
  mutedNumbers: z.array(z.string().trim().regex(/^\+?\d{6,20}$/, "Número inválido")).max(5000).default([]),
});
