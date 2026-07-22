/**
 * Envio de mensajes salientes de WhatsApp para el agente y el scheduler.
 * Resuelve el proveedor del canal de la empresa (WhatsappConfig.provider:
 * SMS Tools o Meta Cloud API) y expone helpers de texto y multimedia con un
 * sender opaco: los consumidores (delivery, scheduler, campañas, panel) no
 * saben ni les importa qué proveedor hay detrás.
 */

import { prisma } from "../../lib/prisma";
import { smsTools } from "../../lib/smstools-client";
import { metaWa, META_MEDIA_LIMITS, mediaTooLargeReason } from "../../lib/meta-wa-client";
import { AppError } from "../../lib/app-error";
import { decryptCredential } from "../../lib/credentials-crypto";
import { socketService, SOCKET_EVENTS } from "../../lib/socket";

// El canal WEB (widget embebible) es un sender más: el mensaje se emite por
// Socket.IO a la room del visitante en lugar de ir a un gateway de WhatsApp.
// Así deliver/flushOutbox, el motor de flujos y las entregas de pago funcionan
// sin bifurcar; la persistencia la sigue haciendo recordMessage en deliver().
export type WhatsappSender =
  | { provider: "SMSTOOLS"; apiUrl: string; secret: string; account: string }
  | { provider: "META"; accessToken: string; phoneNumberId: string }
  | { provider: "WEB"; conversationId: string };

/** Sender del chat web para una conversación (canal "web"). */
export function webSender(conversationId: string): WhatsappSender {
  return { provider: "WEB", conversationId };
}

/**
 * Devuelve las credenciales de envio de la empresa segun su proveedor, o null
 * si no hay una WhatsappConfig activa completa (no se puede responder sin eso).
 */
export async function loadWhatsappSender(companyId: string): Promise<WhatsappSender | null> {
  const config = await prisma.whatsappConfig.findFirst({
    where: { companyId, isActive: true },
  });
  if (!config) return null;
  if (config.provider === "META") {
    if (!config.metaAccessToken || !config.metaPhoneNumberId) return null;
    return {
      provider: "META",
      accessToken: decryptCredential(config.metaAccessToken),
      phoneNumberId: config.metaPhoneNumberId,
    };
  }
  if (!config.account) return null;
  return { provider: "SMSTOOLS", apiUrl: config.apiUrl, secret: config.secret, account: config.account };
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
  /** id del mensaje en el gateway (SMS Tools messageId o wamid de Meta), para rastrear su estado. */
  gatewayId: string | null;
}

/** Descarga un archivo (de nuestro /uploads u otra URL) a un Buffer + mimeType, para subirlo a Meta. */
async function fetchMediaBuffer(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (error) {
    throw new AppError(
      error instanceof Error ? `No se pudo descargar la media a enviar: ${error.message}` : "No se pudo descargar la media a enviar",
      502,
    );
  }
  if (!res.ok) throw new AppError(`No se pudo descargar la media a enviar (HTTP ${res.status}).`, 502);
  const buffer = Buffer.from(await res.arrayBuffer());
  const mimeType = (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();
  return { buffer, mimeType };
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
  if (sender.provider === "WEB") {
    socketService.emitToWebchat(sender.conversationId, SOCKET_EVENTS.WEBCHAT_MESSAGE, {
      conversationId: sender.conversationId,
      role: "ASSISTANT",
      message,
      createdAt: new Date().toISOString(),
    });
    return { gatewayId: null };
  }
  if (sender.provider === "META") {
    const res = await metaWa.sendText(sender, to, message);
    return { gatewayId: res.wamid };
  }
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
  fileName?: string,
): Promise<SendResult> {
  if (sender.provider === "WEB") {
    socketService.emitToWebchat(sender.conversationId, SOCKET_EVENTS.WEBCHAT_MESSAGE, {
      conversationId: sender.conversationId,
      role: "ASSISTANT",
      message: caption ?? null,
      mediaUrl,
      mediaType: kind,
      fileName: fileName ?? null,
      createdAt: new Date().toISOString(),
    });
    return { gatewayId: null };
  }
  if (sender.provider === "META") {
    // Subir el archivo a Meta primero (en vez de enviarlo por link): preserva
    // el orden de la secuencia y da errores de tamaño/formato claros.
    const { buffer, mimeType } = await fetchMediaBuffer(mediaUrl);
    // El video NO se valida por tamaño aquí: la conversión al subir ya lo
    // normaliza/comprime, y en la práctica Meta acepta videos >16MB (un video
    // de cámara de 18MB se entregó). Para image/audio/document sí se valida.
    if (kind !== "video" && buffer.length > META_MEDIA_LIMITS[kind]) {
      throw new AppError(mediaTooLargeReason(kind, buffer.length), 422);
    }
    const filename = fileName ?? mediaUrl.split("/").pop()?.split("?")[0] ?? `archivo.${kind}`;
    const mediaId = await metaWa.uploadMedia(sender, { buffer, mimeType, filename });
    const res = await metaWa.sendMediaById(sender, to, kind, mediaId, caption, fileName);
    // La Cloud API no soporta caption en audio: mandarla como texto aparte
    // para no perder el mensaje que acompañaba al adjunto.
    if (kind === "audio" && caption) {
      await metaWa.sendText(sender, to, caption).catch(() => undefined);
    }
    return { gatewayId: res.wamid };
  }
  const res = await smsTools.sendMedia(
    { apiUrl: sender.apiUrl, secret: sender.secret },
    sender.account,
    to,
    kind,
    mediaUrl,
    caption,
    fileName,
  );
  return { gatewayId: gatewayIdOf(res) };
}
