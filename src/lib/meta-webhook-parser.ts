/**
 * Parser del webhook de Meta WhatsApp Cloud API → InboundMessage (el mismo
 * shape normalizado que produce parseInboundWebhook de SMS Tools), de modo que
 * handleInbound y todo el pipeline del agente quedan intactos.
 *
 * Un POST puede traer varios entry/changes con mensajes Y statuses mezclados.
 * - Mensajes: `value.messages[]` — `account` se rellena con el phone_number_id
 *   (llave de resolución de tenant); la media llega como `media id` (no URL),
 *   se devuelve aparte para que el servicio la resuelva con el token del tenant.
 * - Statuses: `value.statuses[]` — sent/delivered/read/failed por wamid.
 */

import type { InboundMessage } from "./smstools-client";

export type MetaStatusUpdate = {
  wamid: string;
  status: "sent" | "delivered" | "read" | "failed";
  phoneNumberId: string;
  recipient: string | null;
  errorCode: number | null;
  errorMessage: string | null;
};

export type MetaInboundItem = {
  inbound: InboundMessage;
  phoneNumberId: string;
  /** media id de Meta (imagen/video/audio/documento/sticker) o null */
  mediaId: string | null;
};

export type ParsedMetaWebhook = {
  messages: MetaInboundItem[];
  statuses: MetaStatusUpdate[];
};

type MetaMessage = {
  id?: string;
  from?: string;
  type?: string;
  timestamp?: string;
  text?: { body?: string };
  image?: { id?: string; caption?: string; mime_type?: string };
  video?: { id?: string; caption?: string; mime_type?: string };
  audio?: { id?: string; mime_type?: string; voice?: boolean };
  document?: { id?: string; caption?: string; filename?: string; mime_type?: string };
  sticker?: { id?: string; mime_type?: string };
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
  button?: { text?: string; payload?: string };
  reaction?: { message_id?: string; emoji?: string };
};

type MetaValue = {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  messages?: MetaMessage[];
  statuses?: Array<{
    id?: string;
    status?: string;
    recipient_id?: string;
    errors?: Array<{ code?: number; title?: string; message?: string; error_data?: { details?: string } }>;
  }>;
};

function digits(v: string | undefined | null): string | null {
  const d = String(v ?? "").replace(/\D/g, "");
  return d.length ? d : null;
}

function mapMessage(msg: MetaMessage, value: MetaValue): MetaInboundItem | null {
  const phoneNumberId = value.metadata?.phone_number_id;
  if (!phoneNumberId || !msg.from) return null;

  let text = "";
  let type: InboundMessage["type"] = "text";
  let mediaId: string | null = null;

  switch (msg.type) {
    case "text":
      text = msg.text?.body ?? "";
      break;
    case "image":
      type = "image";
      mediaId = msg.image?.id ?? null;
      text = msg.image?.caption ?? "";
      break;
    case "sticker":
      type = "image";
      mediaId = msg.sticker?.id ?? null;
      break;
    case "video":
      type = "video";
      mediaId = msg.video?.id ?? null;
      text = msg.video?.caption ?? "";
      break;
    case "audio":
      type = "audio";
      mediaId = msg.audio?.id ?? null;
      break;
    case "document":
      type = "document";
      mediaId = msg.document?.id ?? null;
      text = msg.document?.caption ?? "";
      break;
    case "location": {
      const l = msg.location;
      const label = [l?.name, l?.address].filter(Boolean).join(", ");
      text = `Ubicación${label ? ` (${label})` : ""}: ${l?.latitude ?? "?"}, ${l?.longitude ?? "?"}`;
      break;
    }
    case "interactive":
      text =
        msg.interactive?.button_reply?.title ??
        msg.interactive?.list_reply?.title ??
        "";
      break;
    case "button":
      text = msg.button?.text ?? "";
      break;
    case "reaction":
      // Reacciones no aportan al agente; se descartan.
      return null;
    default:
      // Tipo no soportado (contacts, order, unknown...): sin texto → descartar.
      return null;
  }

  if (!text && !mediaId) return null;

  const inbound: InboundMessage = {
    messageId: msg.id ?? null,
    fromPhone: digits(msg.from),
    businessPhone: digits(value.metadata?.display_phone_number),
    // El phone_number_id viaja como "account": resolveCompanyByAccount matchea
    // WhatsappConfig.metaPhoneNumberId además de account (SMS Tools).
    account: phoneNumberId,
    text,
    type,
    mediaUrl: null, // Meta entrega media id; el servicio la resuelve con el token
    fromMe: false, // la Cloud API no ecoa salientes en `messages`
    raw: msg,
  };

  return { inbound, phoneNumberId, mediaId };
}

export function parseMetaWebhook(raw: unknown): ParsedMetaWebhook {
  const out: ParsedMetaWebhook = { messages: [], statuses: [] };
  const body = (raw ?? {}) as { object?: string; entry?: Array<{ changes?: Array<{ field?: string; value?: MetaValue }> }> };
  if (!Array.isArray(body.entry)) return out;

  for (const entry of body.entry) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages" || !change.value) continue;
      const value = change.value;
      const phoneNumberId = value.metadata?.phone_number_id ?? "";

      for (const msg of value.messages ?? []) {
        try {
          const item = mapMessage(msg, value);
          if (item) out.messages.push(item);
        } catch (err) {
          console.error("[meta-parser] mensaje descartado:", err instanceof Error ? err.message : err);
        }
      }

      for (const st of value.statuses ?? []) {
        const status = String(st.status ?? "").toLowerCase();
        if (!st.id || !["sent", "delivered", "read", "failed"].includes(status)) continue;
        const firstErr = st.errors?.[0];
        out.statuses.push({
          wamid: st.id,
          status: status as MetaStatusUpdate["status"],
          phoneNumberId,
          recipient: digits(st.recipient_id),
          errorCode: firstErr?.code ?? null,
          errorMessage: firstErr?.title ?? firstErr?.message ?? firstErr?.error_data?.details ?? null,
        });
      }
    }
  }
  return out;
}
