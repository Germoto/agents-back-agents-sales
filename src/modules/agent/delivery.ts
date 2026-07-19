/**
 * Entrega de mensajes salientes (texto/multimedia) con registro en la
 * conversación. Compartido por el turno del agente IA y el motor de flujos
 * (extraído de agent.service.ts para evitar ciclos de imports).
 */

import { recordMessage, notifyOwner } from "./conversation.service";
import { sendText, sendMedia, type WhatsappSender } from "./outbound";
import { applyFirma } from "./firma";
import type { OutboxMessage } from "./agent-tools";

/**
 * Pausa entre envíos para preservar el ORDEN en WhatsApp (sin esto, mensajes y
 * adjuntos enviados muy rápido pueden reordenarse o limitarse por rate).
 */
export const OUTBOX_GAP_MS = 900;

/**
 * Gap efectivo entre mensajes consecutivos del bot según la config de la
 * empresa: si activó la pausa (Empresa → Ritmo de mensajes) se usan sus
 * segundos; si no, el ritmo estándar OUTBOX_GAP_MS.
 */
export function gapMsFor(business: { messageGapEnabled?: boolean; messageGapSeconds?: number } | null | undefined): number {
  if (business?.messageGapEnabled && business.messageGapSeconds && business.messageGapSeconds > 0) {
    return business.messageGapSeconds * 1000;
  }
  return OUTBOX_GAP_MS;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface DeliveryIds {
  companyId: string;
  customerId: string;
  conversationId: string;
}

/**
 * Envía un mensaje y lo registra en la conversación. Devuelve true si el
 * gateway lo aceptó; false si falló (el error se traga aquí para no romper el
 * turno del agente/flujo — las campañas sí usan el retorno para marcar FAILED).
 */
export async function deliver(
  sender: WhatsappSender,
  to: string,
  msg: OutboxMessage,
  ids: DeliveryIds,
): Promise<boolean> {
  try {
    if (msg.kind === "media" && msg.mediaUrl) {
      // La firma se aplica solo cuando el media trae caption con texto.
      const caption = await applyFirma(ids.companyId, msg.caption);
      const r = await sendMedia(sender, to, msg.mediaKind ?? "image", msg.mediaUrl, caption ?? undefined, msg.fileName);
      await recordMessage({
        companyId: ids.companyId,
        customerId: ids.customerId,
        conversationId: ids.conversationId,
        role: "ASSISTANT",
        message: caption ?? null,
        mediaUrl: msg.mediaUrl,
        mediaType: msg.mediaKind ?? "image",
        gatewayId: r.gatewayId,
        deliveryStatus: r.gatewayId ? "pending" : null,
      });
    } else if (msg.text) {
      const text = (await applyFirma(ids.companyId, msg.text)) ?? msg.text;
      const r = await sendText(sender, to, text);
      await recordMessage({
        companyId: ids.companyId,
        customerId: ids.customerId,
        conversationId: ids.conversationId,
        role: "ASSISTANT",
        message: text,
        gatewayId: r.gatewayId,
        deliveryStatus: r.gatewayId ? "pending" : null,
      });
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error("[agent] error enviando WhatsApp:", reason);
    // Con Meta, el fallo de media es síncrono (subida/tamaño rechazados): avisar
    // al dueño con el motivo claro (antes esto lo hacía el webhook de status).
    // Para SMS Tools se mantiene el comportamiento de solo loguear.
    if (sender.provider === "META" && msg.kind === "media") {
      await notifyOwner(
        ids.companyId,
        `⚠️ No se pudo enviar un archivo al cliente por WhatsApp (Meta).\nMotivo: ${reason}`,
      ).catch(() => undefined);
    }
    return false;
  }
  return true;
}

export async function flushOutbox(
  sender: WhatsappSender,
  to: string,
  outbox: OutboxMessage[],
  ids: DeliveryIds,
  gapMs: number = OUTBOX_GAP_MS,
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < outbox.length; i++) {
    const ok = await deliver(sender, to, outbox[i], ids);
    if (ok) sent++;
    else failed++;
    if (i < outbox.length - 1) await sleep(gapMs);
  }
  return { sent, failed };
}
