/**
 * Secuencias de recordatorios (por tipo) con variables.
 *
 * Cada tipo puede tener VARIOS mensajes (steps), cada uno con su propio delay
 * (en segundos) y contenido (texto + multimedia). Resuelve combinando:
 * defaults → plantilla del negocio (AgentConfig.followupConfig) → override por
 * producto (Product.reminderConfig). Sustituye {nombre} {producto} {total}
 * {negocio}. Compatible con la forma vieja (un solo mensaje: delayMinutes/message/
 * mediaUrl) → se normaliza a 1 step.
 */

export type ReminderType = "abandonedCart" | "leftOnRead";

export interface ReminderStep {
  delaySeconds: number;
  message: string;
  mediaUrl: string | null;
  mediaType: string;
}

export interface ReminderSequence {
  enabled: boolean;
  steps: ReminderStep[];
}

export interface ReminderVars {
  nombre?: string;
  producto?: string;
  total?: string;
  negocio?: string;
}

const DEFAULTS: Record<ReminderType, ReminderSequence> = {
  abandonedCart: {
    enabled: true,
    steps: [
      {
        delaySeconds: 6 * 3600,
        message: "Hola {nombre} 👋 vi que quedó pendiente tu compra de {producto}. ¿Te ayudo a completarla? Sigue disponible 🙌",
        mediaUrl: null,
        mediaType: "",
      },
    ],
  },
  leftOnRead: {
    enabled: false,
    steps: [
      {
        delaySeconds: 3600,
        message: "Hola {nombre} 👋 ¿seguimos? Cualquier duda sobre {producto} te ayudo encantado.",
        mediaUrl: null,
        mediaType: "",
      },
    ],
  },
};

function asObj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function boolOf(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function substituteVars(text: string, vars: ReminderVars): string {
  return text
    .replace(/\{nombre\}/gi, vars.nombre || "")
    .replace(/\{producto\}/gi, vars.producto || "tu pedido")
    .replace(/\{total\}/gi, vars.total || "")
    .replace(/\{negocio\}/gi, vars.negocio || "")
    // Colapsa solo espacios/tabs horizontales (NO los saltos de línea) y limpia
    // espacios al final de cada línea, para preservar el formato configurado.
    .replace(/[^\S\n]{2,}/g, " ")
    .replace(/[^\S\n]+\n/g, "\n")
    .trim();
}

/**
 * Extrae los steps de una config por tipo. Soporta la forma nueva ({steps:[...]})
 * y la vieja (un solo recordatorio: {delayMinutes, message, mediaUrl}). Devuelve
 * null si no hay nada usable. Descarta steps sin texto ni multimedia.
 */
function stepsFrom(cfg: Record<string, unknown>): ReminderStep[] | null {
  const raw = cfg.steps;
  if (Array.isArray(raw)) {
    const steps: ReminderStep[] = [];
    for (const item of raw) {
      const s = asObj(item);
      const delaySeconds =
        typeof s.delaySeconds === "number"
          ? s.delaySeconds
          : typeof s.delayMinutes === "number"
          ? s.delayMinutes * 60
          : 0;
      const message = typeof s.message === "string" ? s.message : "";
      const mediaUrl = typeof s.mediaUrl === "string" && s.mediaUrl.trim() ? s.mediaUrl : null;
      const mediaType = typeof s.mediaType === "string" ? s.mediaType : "";
      if (message.trim() || mediaUrl) {
        steps.push({ delaySeconds: Math.max(1, Math.round(delaySeconds)), message, mediaUrl, mediaType });
      }
    }
    return steps.length ? steps : null;
  }
  // Forma vieja: un solo recordatorio.
  const hasLegacy =
    typeof cfg.delayMinutes === "number" ||
    (typeof cfg.message === "string" && cfg.message.trim()) ||
    (typeof cfg.mediaUrl === "string" && cfg.mediaUrl.trim());
  if (hasLegacy) {
    const delayMinutes = typeof cfg.delayMinutes === "number" ? cfg.delayMinutes : 60;
    return [
      {
        delaySeconds: Math.max(1, Math.round(delayMinutes * 60)),
        message: typeof cfg.message === "string" ? cfg.message : "",
        mediaUrl: typeof cfg.mediaUrl === "string" && cfg.mediaUrl.trim() ? cfg.mediaUrl : null,
        mediaType: "",
      },
    ];
  }
  return null;
}

/**
 * Resuelve la SECUENCIA final (enabled + steps con variables substituidas) para
 * un tipo. `productReminderConfig` es el override por producto, opcional.
 * Precedencia de steps: producto → tenant → default. `enabled` se resuelve por
 * separado (override.enabled ?? tenant.enabled ?? default) para poder desactivar
 * desde el producto.
 */
export function resolveReminderSequence(
  followupConfig: unknown,
  type: ReminderType,
  productReminderConfig?: unknown,
  vars: ReminderVars = {},
): ReminderSequence {
  const override = asObj(asObj(productReminderConfig)[type]);
  const tenant = asObj(asObj(followupConfig)[type]);
  const def = DEFAULTS[type];

  const enabled = boolOf(override.enabled) ?? boolOf(tenant.enabled) ?? def.enabled;
  const steps = stepsFrom(override) ?? stepsFrom(tenant) ?? def.steps;

  return {
    enabled,
    steps: steps.map((s) => ({ ...s, message: substituteVars(s.message, vars) })),
  };
}
