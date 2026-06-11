/**
 * Entrega de mensajes salientes (texto/multimedia) con registro en la
 * conversación. Compartido por el turno del agente IA y el motor de flujos
 * (extraído de agent.service.ts para evitar ciclos de imports).
 */

import { recordMessage } from "./conversation.service";
import { sendText, sendMedia, type WhatsappSender } from "./outbound";
import type { OutboxMessage } from "./agent-tools";

/**
 * Pausa entre envíos para preservar el ORDEN en WhatsApp (sin esto, mensajes y
 * adjuntos enviados muy rápido pueden reordenarse o limitarse por rate).
 */
export const OUTBOX_GAP_MS = 900;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface DeliveryIds {
  companyId: string;
  customerId: string;
  conversationId: string;
}

export async function deliver(
  sender: WhatsappSender,
  to: string,
  msg: OutboxMessage,
  ids: DeliveryIds,
): Promise<void> {
  try {
    if (msg.kind === "media" && msg.mediaUrl) {
      const r = await sendMedia(sender, to, msg.mediaKind ?? "image", msg.mediaUrl, msg.caption, msg.fileName);
      await recordMessage({
        companyId: ids.companyId,
        customerId: ids.customerId,
        conversationId: ids.conversationId,
        role: "ASSISTANT",
        message: msg.caption ?? null,
        mediaUrl: msg.mediaUrl,
        mediaType: msg.mediaKind ?? "image",
        gatewayId: r.gatewayId,
        deliveryStatus: r.gatewayId ? "pending" : null,
      });
    } else if (msg.text) {
      const r = await sendText(sender, to, msg.text);
      await recordMessage({
        companyId: ids.companyId,
        customerId: ids.customerId,
        conversationId: ids.conversationId,
        role: "ASSISTANT",
        message: msg.text,
        gatewayId: r.gatewayId,
        deliveryStatus: r.gatewayId ? "pending" : null,
      });
    }
  } catch (err) {
    console.error("[agent] error enviando WhatsApp:", err instanceof Error ? err.message : err);
  }
}

export async function flushOutbox(
  sender: WhatsappSender,
  to: string,
  outbox: OutboxMessage[],
  ids: DeliveryIds,
): Promise<void> {
  for (let i = 0; i < outbox.length; i++) {
    await deliver(sender, to, outbox[i], ids);
    if (i < outbox.length - 1) await sleep(OUTBOX_GAP_MS);
  }
}
