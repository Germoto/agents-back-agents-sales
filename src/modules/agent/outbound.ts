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
import { decodeEntities } from "../../lib/html-entities";
import { decryptCredential } from "../../lib/credentials-crypto";
import { socketService, SOCKET_EVENTS } from "../../lib/socket";
import { DOCUMENT_MIME, META_DOCUMENT_EXTS, extOf, isDocumentExt } from "../../lib/document-types";

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
  opts?: { quoteWamid?: string | null; quoteFrom?: "" | "me" },
): Promise<SendResult> {
  // Nunca mandar entidades HTML al cliente (`&quot;` en vez de comillas).
  message = decodeEntities(message);
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
    const res = await metaWa.sendText(sender, to, message, { quoteWamid: opts?.quoteWamid });
    return { gatewayId: res.wamid };
  }
  const res = await smsTools.sendMessage(
    { apiUrl: sender.apiUrl, secret: sender.secret },
    sender.account,
    to,
    message,
    opts?.quoteWamid ? { quoteWamid: opts.quoteWamid, quoteFrom: opts.quoteFrom ?? "" } : undefined,
  );
  return { gatewayId: gatewayIdOf(res) };
}

/** Encuestas nativas de WhatsApp: solo el gateway SMS Tools las soporta. */
export function supportsPolls(sender: WhatsappSender): boolean {
  return sender.provider === "SMSTOOLS";
}

/**
 * Envía una encuesta nativa (botonera). Meta Cloud API y el chat web no tienen
 * encuestas: lanzan 422 y el caller (deliver) degrada al menú numerado.
 */
export async function sendPoll(
  sender: WhatsappSender,
  to: string,
  poll: { question: string; options: string[]; selectable?: number },
): Promise<SendResult> {
  if (!supportsPolls(sender) || sender.provider !== "SMSTOOLS") {
    throw new AppError("Este canal no soporta encuestas de WhatsApp", 422);
  }
  const res = await smsTools.sendPoll(
    { apiUrl: sender.apiUrl, secret: sender.secret },
    sender.account,
    to,
    { question: decodeEntities(poll.question), options: poll.options.map((o) => decodeEntities(o)), selectable: poll.selectable },
  );
  return { gatewayId: gatewayIdOf(res) };
}

/**
 * Reacciona con un emoji a un mensaje del chat (emoji "" = quitar). El wamid es
 * el de WhatsApp del mensaje target; fromMe=true si el target es nuestro.
 */
export async function sendReaction(
  sender: WhatsappSender,
  to: string,
  opts: { wamid: string; emoji: string; fromMe: boolean },
): Promise<void> {
  if (sender.provider === "WEB") {
    throw new AppError("Las reacciones no están disponibles en el chat web", 422);
  }
  if (sender.provider === "META") {
    await metaWa.sendReaction(sender, to, { messageId: opts.wamid, emoji: opts.emoji });
    return;
  }
  await smsTools.sendReaction(
    { apiUrl: sender.apiUrl, secret: sender.secret },
    sender.account,
    { recipient: to, wamid: opts.wamid, reaction: opts.emoji, fromMe: opts.fromMe },
  );
}

/**
 * Dispara el indicador "escribiendo…/grabando…" hacia el cliente (best-effort).
 * Solo SMS Tools lo soporta; Meta Cloud API y el chat web son no-op silencioso.
 */
export async function sendTyping(
  sender: WhatsappSender,
  to: string,
  state: "composing" | "recording" | "paused",
): Promise<void> {
  if (sender.provider !== "SMSTOOLS") return;
  await smsTools.sendTyping(
    { apiUrl: sender.apiUrl, secret: sender.secret },
    sender.account,
    { recipient: to, state },
  );
}

/**
 * Nombre visible de un documento: el que mande el caller; si no, el originalName
 * del ProductFile con esa URL (recordatorios, followups, banner y reintentos no
 * lo pasan); si no, el último segmento de la URL.
 */
export async function resolveDocumentFileName(mediaUrl: string, fileName?: string | null): Promise<string> {
  const given = fileName?.trim();
  if (given) return given;
  try {
    const pf = await prisma.productFile.findFirst({ where: { url: mediaUrl }, select: { originalName: true } });
    if (pf?.originalName?.trim()) return pf.originalName.trim();
  } catch {
    /* best-effort */
  }
  const last = mediaUrl.split("/").pop()?.split("?")[0] ?? "";
  try {
    return decodeURIComponent(last) || "documento";
  } catch {
    return last || "documento";
  }
}

export async function sendMedia(
  sender: WhatsappSender,
  to: string,
  kind: "image" | "document" | "video" | "audio" | "sticker",
  mediaUrl: string,
  caption?: string,
  fileName?: string,
): Promise<SendResult> {
  if (caption) caption = decodeEntities(caption);
  if (kind === "document") fileName = await resolveDocumentFileName(mediaUrl, fileName);
  // Los stickers viajan sin texto: el caption (si lo hay) va como texto aparte.
  if (kind === "sticker" && caption) {
    const r = await sendMedia(sender, to, "sticker", mediaUrl);
    await sendText(sender, to, caption).catch(() => undefined);
    return r;
  }
  if (sender.provider === "WEB") {
    socketService.emitToWebchat(sender.conversationId, SOCKET_EVENTS.WEBCHAT_MESSAGE, {
      conversationId: sender.conversationId,
      role: "ASSISTANT",
      message: caption ?? null,
      mediaUrl,
      // El widget web no distingue stickers: se muestra como imagen.
      mediaType: kind === "sticker" ? "image" : kind,
      fileName: fileName ?? null,
      createdAt: new Date().toISOString(),
    });
    return { gatewayId: null };
  }
  if (sender.provider === "META") {
    // Meta solo admite como `document` txt/xls/xlsx/doc/docx/ppt/pptx/pdf: el resto
    // (zip, rar, 7z, csv, xml) se entrega como enlace para no romper el envío.
    if (kind === "document") {
      const ext = extOf(fileName ?? "") || extOf(mediaUrl);
      if (!META_DOCUMENT_EXTS.has(ext)) {
        console.warn(`[outbound] Meta no admite .${ext || "?"} como documento: se envía como enlace`);
        const text = `📎 ${fileName ?? "Archivo"}: ${mediaUrl}${caption ? `\n\n${caption}` : ""}`;
        const res = await metaWa.sendText(sender, to, text);
        return { gatewayId: res.wamid };
      }
    }
    // Subir el archivo a Meta primero (en vez de enviarlo por link): preserva
    // el orden de la secuencia y da errores de tamaño/formato claros.
    const fetched = await fetchMediaBuffer(mediaUrl);
    const buffer = fetched.buffer;
    // Documentos: MIME canónico por extensión (express.static puede servir octet-stream).
    const docExt = kind === "document" ? extOf(fileName ?? "") || extOf(mediaUrl) : "";
    const mimeType = isDocumentExt(docExt) ? DOCUMENT_MIME[docExt] : fetched.mimeType;
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
