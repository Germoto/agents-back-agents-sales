/**
 * Plantillas de recordatorios (por tipo) con variables.
 *
 * Resuelve el contenido a enviar combinando: defaults → plantilla del negocio
 * (AgentConfig.followupConfig) → override por producto (Product.reminderConfig).
 * Sustituye variables {nombre} {producto} {total} {negocio}. Compatible con la
 * forma vieja de followupConfig (solo horas/minutos).
 */

export type ReminderType = "abandonedCart" | "leftOnRead" | "offerCountdown" | "postSale";

export interface ReminderTemplate {
  enabled: boolean;
  delayMinutes: number;
  message: string;
  mediaUrl: string | null;
}

export interface ReminderVars {
  nombre?: string;
  producto?: string;
  total?: string;
  negocio?: string;
}

const DEFAULTS: Record<ReminderType, ReminderTemplate> = {
  abandonedCart: {
    enabled: true,
    delayMinutes: 360,
    message: "Hola {nombre} 👋 vi que quedó pendiente tu compra de {producto}. ¿Te ayudo a completarla? Sigue disponible 🙌",
    mediaUrl: null,
  },
  leftOnRead: {
    enabled: false,
    delayMinutes: 60,
    message: "Hola {nombre} 👋 ¿seguimos? Cualquier duda sobre {producto} te ayudo encantado.",
    mediaUrl: null,
  },
  offerCountdown: {
    enabled: false,
    delayMinutes: 1440,
    message: "⏳ Tu oferta de {producto} está por vencer. ¿La aprovechas ahora?",
    mediaUrl: null,
  },
  postSale: {
    enabled: true,
    delayMinutes: 1440,
    message: "Hola {nombre} 👋 ¿cómo te fue con {producto}? Si necesitas algo aquí estoy. ¿Te muestro algo más del catálogo?",
    mediaUrl: null,
  },
};

function asObj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// Compatibilidad con la forma vieja: { abandonedCartHours, leftOnReadMinutes, offerCountdownHours }
function legacyDelay(followup: Record<string, unknown>, type: ReminderType): number | undefined {
  if (type === "abandonedCart" && typeof followup.abandonedCartHours === "number") return followup.abandonedCartHours * 60;
  if (type === "leftOnRead" && typeof followup.leftOnReadMinutes === "number") return followup.leftOnReadMinutes;
  if (type === "offerCountdown" && typeof followup.offerCountdownHours === "number") return followup.offerCountdownHours * 60;
  return undefined;
}

export function substituteVars(text: string, vars: ReminderVars): string {
  return text
    .replace(/\{nombre\}/gi, vars.nombre || "")
    .replace(/\{producto\}/gi, vars.producto || "tu pedido")
    .replace(/\{total\}/gi, vars.total || "")
    .replace(/\{negocio\}/gi, vars.negocio || "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Resuelve la plantilla final para un tipo. `productReminderConfig` es el
 * Product.reminderConfig (override por producto), opcional.
 */
export function resolveReminderTemplate(
  followupConfig: unknown,
  type: ReminderType,
  productReminderConfig?: unknown,
  vars: ReminderVars = {},
): ReminderTemplate {
  const followup = asObj(followupConfig);
  const tenant = asObj(followup[type]);
  const override = asObj(asObj(productReminderConfig)[type]);
  const def = DEFAULTS[type];

  const enabled =
    typeof override.enabled === "boolean"
      ? (override.enabled as boolean)
      : typeof tenant.enabled === "boolean"
      ? (tenant.enabled as boolean)
      : // forma vieja: si había un delay configurado, lo consideramos activo
        legacyDelay(followup, type) !== undefined || def.enabled;

  const delayMinutes =
    (typeof override.delayMinutes === "number" && override.delayMinutes) ||
    (typeof tenant.delayMinutes === "number" && tenant.delayMinutes) ||
    legacyDelay(followup, type) ||
    def.delayMinutes;

  const rawMessage =
    (typeof override.message === "string" && override.message.trim() && override.message) ||
    (typeof tenant.message === "string" && tenant.message.trim() && tenant.message) ||
    def.message;

  const mediaUrl =
    (typeof override.mediaUrl === "string" && override.mediaUrl.trim() && override.mediaUrl) ||
    (typeof tenant.mediaUrl === "string" && tenant.mediaUrl.trim() && tenant.mediaUrl) ||
    null;

  return {
    enabled,
    delayMinutes: Math.max(1, delayMinutes),
    message: substituteVars(rawMessage, vars),
    mediaUrl,
  };
}
