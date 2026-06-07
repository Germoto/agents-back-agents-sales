/**
 * Envio de mensajes salientes de WhatsApp para el agente y el scheduler.
 * Resuelve las credenciales SMS Tools (WhatsappConfig) de la empresa y expone
 * helpers de texto y multimedia. Centraliza aqui para no repetir la resolucion
 * de credenciales en cada lugar que necesite responder por WhatsApp.
 */

import { prisma } from "../../lib/prisma";
import { smsTools } from "../../lib/smstools-client";

export interface WhatsappSender {
  apiUrl: string;
  secret: string;
  account: string;
}

/**
 * Devuelve las credenciales de envio de la empresa, o null si no hay una
 * WhatsappConfig activa con account vinculado (no se puede responder sin eso).
 */
export async function loadWhatsappSender(companyId: string): Promise<WhatsappSender | null> {
  const config = await prisma.whatsappConfig.findFirst({
    where: { companyId, isActive: true },
  });
  if (!config || !config.account) return null;
  return { apiUrl: config.apiUrl, secret: config.secret, account: config.account };
}

/** Tipo de adjunto WhatsApp segun el tipo de ProductFile / media. */
export function mediaKindFor(type: string): "image" | "document" | "video" | "audio" {
  const t = type.toLowerCase();
  if (t === "image") return "image";
  if (t === "video") return "video";
  if (t === "audio") return "audio";
  return "document"; // pdf y otros
}

export interface SendResult {
  /** id del mensaje en el gateway (data.messageId del envío), para rastrear su estado. */
  gatewayId: string | null;
}

/** Extrae el id del gateway de la respuesta del envío (messageId, con fallback a id). */
function gatewayIdOf(res: unknown): string | null {
  const r = (res ?? {}) as Record<string, unknown>;
  const v = r.messageId ?? r.id;
  return v != null && v !== "" ? String(v) : null;
}

export async function sendText(
  sender: WhatsappSender,
  to: string,
  message: string,
): Promise<SendResult> {
  const res = await smsTools.sendMessage(
    { apiUrl: sender.apiUrl, secret: sender.secret },
    sender.account,
    to,
    message,
  );
  return { gatewayId: gatewayIdOf(res) };
}

export async function sendMedia(
  sender: WhatsappSender,
  to: string,
  kind: "image" | "document" | "video" | "audio",
  mediaUrl: string,
  caption?: string,
): Promise<SendResult> {
  const res = await smsTools.sendMedia(
    { apiUrl: sender.apiUrl, secret: sender.secret },
    sender.account,
    to,
    kind,
    mediaUrl,
    caption,
  );
  return { gatewayId: gatewayIdOf(res) };
}
