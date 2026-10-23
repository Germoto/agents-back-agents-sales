import { z } from "zod";

// Un mensaje (step) de la secuencia: demora (seg) + texto + multimedia.
const reminderStepSchema = z.object({
  delaySeconds: z.coerce.number().min(1).max(100000000),
  message: z.string().optional().default(""),
  mediaUrl: z.string().nullable().optional(),
  mediaType: z.string().optional().default(""),
  // Oferta escalonada: al enviarse este paso, el agente ofrece/cobra/valida
  // este precio SOLO para ese cliente. Usa {oferta} en el mensaje para mostrarlo.
  offerPrice: z.string().trim().max(40).nullable().optional(),
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

// Franja horaria (hora local del tenant) en que se permiten enviar recordatorios.
const quietHoursSchema = z
  .object({
    startHour: z.coerce.number().int().min(0).max(23),
    endHour: z.coerce.number().int().min(1).max(24),
    // Dispersión al abrir: lo acumulado fuera de horario se reparte al azar en los
    // primeros N minutos de la ventana (0 = todo a la hora exacta). Default 90.
    spreadMinutes: z.coerce.number().int().min(0).max(180).optional(),
  })
  .optional();

// Ritmo anti-ráfaga de recordatorios por empresa: separación al azar entre envíos
// consecutivos [minSec, maxSec] y tope de recordatorios visibles por hora.
const pacingSchema = z
  .object({
    minSec: z.coerce.number().int().min(5).max(600),
    maxSec: z.coerce.number().int().min(5).max(900),
    maxPerHour: z.coerce.number().int().min(5).max(500),
  })
  .refine((p) => p.maxSec >= p.minSec, { message: "maxSec debe ser ≥ minSec" })
  .nullable()
  .optional();

// Plantilla de Meta de respaldo para recordatorios fuera de la ventana de 24h
// (solo tenants con proveedor META; opcional — sin ella el recordatorio se omite).
const metaTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    language: z.string().trim().min(2).max(10).default("es"),
    params: z.array(z.string().max(300)).max(10).default([]),
  })
  .nullable()
  .optional();

// Config de recordatorios/seguimientos que consume el agente y el scheduler.
export const followupConfigSchema = z
  .object({
    abandonedCart: reminderSequenceSchema,
    leftOnRead: reminderSequenceSchema,
    quietHours: quietHoursSchema,
    pacing: pacingSchema,
    metaTemplate: metaTemplateSchema,
  })
  .nullable()
  .optional();

// Herramienta de CRM del agente (actualizar_crm). Cada columna/etiqueta
// permitida lleva su regla "cuándo" (va al prompt y es obligatoria): sin ella
// el agente no tiene criterio y haría cambios mal.
const whenRule = z.string().trim().min(10, "Escribe cuándo debe hacerlo (mínimo 10 caracteres)").max(300);
export const crmToolConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    crmId: z.string().uuid().nullable().optional(),
    columns: z.array(z.object({ columnId: z.string().uuid(), when: whenRule })).max(10).default([]),
    addTags: z.array(z.object({ tagId: z.string().uuid(), when: whenRule })).max(15).default([]),
    removeTagIds: z.array(z.string().uuid()).max(15).default([]),
    onlyForward: z.boolean().default(true),
    maxPerTurn: z.number().int().min(1).max(3).default(1),
    notifyOwner: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (!v.enabled) return;
    if (!v.crmId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["crmId"], message: "Elige el tablero sobre el que puede actuar" });
    if (!v.columns.length && !v.addTags.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["columns"], message: "Permite al menos una columna o una etiqueta" });
    }
  });
export type CrmToolConfig = z.infer<typeof crmToolConfigSchema>;

// Núcleo de Agente IA (modelo + prompt). Recordatorios y modo de respuesta se
// guardan por separado (módulos Recordatorios y Pruebas) para no pisarlos.
export const coreAgentConfigSchema = z.object({
  // Proveedor de IA: openaiModel/openaiApiKey son el modelo/key del proveedor elegido.
  aiProvider: z.enum(["OPENAI", "ANTHROPIC", "GOOGLE"]).default("OPENAI"),
  openaiModel: z.string().min(1).default("gpt-4o-mini"),
  // Opcional: vacío/ausente conserva la key ya guardada (nunca se reenvía desde el panel).
  openaiApiKey: z.string().trim().max(200).optional(),
  // Key de OpenAI para audios (Whisper) e imágenes (gpt-image) cuando aiProvider != OPENAI. Misma semántica.
  transcriptionApiKey: z.string().trim().max(200).optional(),
  temperature: z.coerce.number().min(0).max(2).default(0.25),
  basePrompt: z.string().min(1),
  salesStyle: z.string().min(1),
  rules: z.array(z.string().min(1)).default([]),
  // Si el cliente pide rebaja: intentar una vez y derivar a un asesor humano.
  negotiationHandoff: z.boolean().optional(),
  // Rubro Comercial: comportamiento del agente configurable.
  catalogMode: z.enum(["preguntar", "resumen_humano", "primeros_n"]).optional(),
  keywordMode: z.enum(["detalle_y_preguntar", "agregar_directo", "auto"]).optional(),
  trackStock: z.boolean().optional(),
  // Presentación del catálogo: texto, carta (PDF/imagen) o ambos. null en la
  // url = quitar la carta guardada.
  catalogMediaMode: z.enum(["text", "media", "both"]).optional(),
  catalogMediaUrl: z.string().trim().max(2000).nullable().optional(),
  catalogMediaType: z.string().trim().max(40).nullable().optional(),
  catalogMediaFileName: z.string().trim().max(255).nullable().optional(),
  // Herramienta de CRM del agente: undefined = no tocar; null = apagar.
  crmToolConfig: crmToolConfigSchema.nullable().optional(),
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
  // Flag: auto-pasar a atención humana tras entregar una venta (catálogo de 1
  // producto sin enganche). Opcional para no pisarlo al guardar solo la lista.
  muteAfterSale: z.boolean().optional(),
});
