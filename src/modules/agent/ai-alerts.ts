/**
 * Alertas al DUEÑO cuando el proveedor de IA falla de forma ACCIONABLE
 * (sin créditos, key inválida): el agente responde a los clientes con el
 * mensaje de disculpa y el negocio debe enterarse al PRIMER fallo, no cuando
 * revise los chats. Incidente real: OpenAI sin saldo dejó al bot 2 horas
 * pidiendo disculpas a 36 clientes sin que nadie lo supiera.
 *
 * La alerta viaja por WhatsApp (notifyOwner → gateway), que no depende del
 * proveedor de IA caído. Anti-spam: 1 alerta por tipo cada 6h por negocio
 * (estado en memoria; tras un reinicio puede re-alertar — aceptable, el
 * problema sigue vigente). Al primer turno exitoso posterior se avisa la
 * recuperación una sola vez.
 */

import { notifyOwner } from "./conversation.service";

type AlertType = "sin_creditos" | "key_invalida";

const COOLDOWN_MS = 6 * 3600_000;

/** Última alerta emitida por empresa (tipo + timestamp). */
const alertedByCompany = new Map<string, { type: AlertType; at: number }>();

/** Clasifica el error del proveedor; null = no accionable (no alertar). */
function classify(err: unknown): { type: AlertType; titulo: string; accion: string } | null {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (/\(401\)/.test(msg) || /invalid api key|incorrect api key|revocada/i.test(msg)) {
    return {
      type: "key_invalida",
      titulo: "la API key del proveedor de IA es inválida o fue revocada",
      accion: "Revisa la key en el panel: Agente IA.",
    };
  }
  if (/\(429\)/.test(msg) && /credit|billing|quota|saldo|insufficient/i.test(msg)) {
    return {
      type: "sin_creditos",
      titulo: "el proveedor de IA se quedó SIN CRÉDITOS",
      accion: "Recarga saldo en la cuenta del proveedor (OpenAI: platform.openai.com → Billing) o cambia de proveedor en el panel (Agente IA).",
    };
  }
  return null; // rate limit transitorio, caída del proveedor, etc.: no alertar (ruido)
}

/** Llamar cuando runAgentTurn falla. Fire-and-forget: jamás rompe el turno. */
export async function alertAiProviderFailure(companyId: string, err: unknown): Promise<void> {
  const detected = classify(err);
  if (!detected) return;
  const prev = alertedByCompany.get(companyId);
  if (prev && prev.type === detected.type && Date.now() - prev.at < COOLDOWN_MS) return;
  alertedByCompany.set(companyId, { type: detected.type, at: Date.now() });
  await notifyOwner(
    companyId,
    `⚠️ *Tu Agente IA está fallando*: ${detected.titulo}.\n\n` +
      `Tus clientes están recibiendo "Disculpa, estoy teniendo un inconveniente" en vez de respuestas reales.\n\n` +
      `${detected.accion}\n\n` +
      `El agente se recupera solo apenas lo soluciones (te aviso por aquí).`,
  );
}

/** Llamar tras un turno EXITOSO: si había alerta activa, avisa la recuperación (una vez). */
export async function notifyAiProviderRecovered(companyId: string): Promise<void> {
  if (!alertedByCompany.has(companyId)) return;
  alertedByCompany.delete(companyId);
  await notifyOwner(companyId, "✅ *Tu Agente IA volvió a responder con normalidad.* Revisa los chats que quedaron colgados durante la falla y reactívalos si hace falta.");
}
