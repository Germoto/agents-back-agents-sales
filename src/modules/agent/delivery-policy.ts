/**
 * Qué hace el revisor de entrega (delivery-status.worker) con un mensaje que el
 * gateway marcó como fallido. Reglas puras, sin base de datos.
 *
 * - Respuestas del bot: se reintentan (hasta el tope) y, si no llegan, se avisa al dueño.
 * - Mensajes del asesor, recordatorios y avisos de pago: solo se les pone el estado.
 *   Nunca se reenvían solos (un recordatorio repetido o un mensaje del asesor duplicado
 *   es peor que un aviso de «no entregado» en el chat).
 */

/** Valores de rawPayload.source que el revisor sigue pero no reenvía. */
export const NO_RETRY_SOURCES = {
  reminder: "reminder",
  paymentNotice: "payment-notice",
  metaTemplate: "meta-template",
} as const;

const NO_RETRY = new Set<string>(Object.values(NO_RETRY_SOURCES));

export type DeliveryPolicy = "retry" | "track";

export function retryPolicyFor(role: string, rawPayload: unknown): DeliveryPolicy {
  if (role !== "ASSISTANT") return "track";
  const source =
    rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload) ? (rawPayload as Record<string, unknown>).source : undefined;
  return typeof source === "string" && NO_RETRY.has(source) ? "track" : "retry";
}
