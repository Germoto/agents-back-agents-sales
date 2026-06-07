import { AppError } from "./app-error";

/**
 * Minimal HTTP client for the SMS TOOLS WhatsApp API.
 * Docs: https://smstools.pro/dashboard/docs#tag/WhatsApp
 *
 * `apiUrl` stored in DB is the full send endpoint (e.g.
 * "https://smstools.pro/api/send/whatsapp"). We derive the API base
 * (everything up to and including "/api") so we can call sibling endpoints.
 */

export type SmsToolsCredentials = {
  apiUrl: string;
  secret: string;
};

export type SmsToolsServer = {
  id: number;
  name?: string;
  location?: string;
  available?: boolean;
  [key: string]: unknown;
};

export type SmsToolsAccount = {
  unique: string;
  phone?: string;
  status?: string;
  server?: { id?: number; name?: string } | null;
  [key: string]: unknown;
};

export type SmsToolsLinkResponse = {
  qrstring: string;
  qrimagelink: string;
  infolink?: string;
  token?: string;
};

export type SmsToolsMessage = {
  id: number | string;
  account?: string;
  status?: string;
  recipient?: string;
  message?: string;
  attachment?: unknown;
  created?: number;
  [key: string]: unknown;
};

type SmsToolsEnvelope<T> = {
  status: number;
  message?: string;
  data: T;
};

export function deriveApiBase(apiUrl: string): string {
  const match = apiUrl.match(/^(https?:\/\/[^/]+\/api)(\/|$)/);
  if (!match) {
    throw new AppError(
      "La URL del proveedor de WhatsApp no parece valida. Debe terminar en /api/...",
      400,
    );
  }
  return match[1];
}

export function extractTokenFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.searchParams.get("token");
  } catch {
    return null;
  }
}

type RequestOptions = {
  query?: Record<string, string | number | boolean | undefined | null>;
  method?: "GET" | "POST" | "DELETE";
  body?: FormData | URLSearchParams;
  responseType?: "json" | "binary";
};

async function smsToolsRequest<T = unknown>(
  apiBase: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const url = new URL(`${apiBase}${path}`);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: options.method ?? "GET",
      body: options.body,
    });
  } catch (error) {
    throw new AppError(
      error instanceof Error
        ? `No se pudo conectar con SMS TOOLS: ${error.message}`
        : "No se pudo conectar con SMS TOOLS",
      502,
    );
  }

  if (options.responseType === "binary") {
    if (!response.ok) {
      throw new AppError("SMS TOOLS respondio con error al solicitar el recurso binario.", 502);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    return { buffer, contentType } as unknown as T;
  }

  const rawText = await response.text();
  let parsed: unknown = null;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch {
    parsed = rawText;
  }

  if (!response.ok) {
    throw new AppError(
      "SMS TOOLS respondio con error.",
      502,
      parsed ?? { rawText },
    );
  }

  const envelope = parsed as SmsToolsEnvelope<T> | null;
  if (envelope && typeof envelope === "object" && typeof envelope.status === "number" && envelope.status >= 400) {
    // SMS TOOLS returns HTTP 200 with envelope.status >= 400 when the request
    // succeeded but the operation has no result (e.g. no servers assigned to
    // the subscription, empty list, etc.). For 404 with falsy data we treat it
    // as "empty" and return null so list wrappers can normalize to [].
    if (envelope.status === 404 && (envelope.data === false || envelope.data === null || envelope.data === undefined)) {
      return null as unknown as T;
    }
    throw new AppError(
      envelope.message ?? "Error del proveedor de WhatsApp.",
      502,
      envelope,
    );
  }

  return (envelope?.data as T) ?? (parsed as T);
}

export const smsTools = {
  async getServers(creds: SmsToolsCredentials): Promise<SmsToolsServer[]> {
    const base = deriveApiBase(creds.apiUrl);
    const data = await smsToolsRequest<SmsToolsServer[]>(base, "/get/wa.servers", {
      query: { secret: creds.secret },
    });
    return Array.isArray(data) ? data : [];
  },

  async getAccounts(creds: SmsToolsCredentials, page = 1, limit = 50): Promise<SmsToolsAccount[]> {
    const base = deriveApiBase(creds.apiUrl);
    const data = await smsToolsRequest<SmsToolsAccount[]>(base, "/get/wa.accounts", {
      query: { secret: creds.secret, page, limit },
    });
    return Array.isArray(data) ? data : [];
  },

  async createLink(creds: SmsToolsCredentials, sid?: number): Promise<SmsToolsLinkResponse> {
    const base = deriveApiBase(creds.apiUrl);
    const data = await smsToolsRequest<SmsToolsLinkResponse>(base, "/create/wa.link", {
      query: { secret: creds.secret, sid },
    });
    return {
      ...data,
      token: extractTokenFromUrl(data?.qrimagelink) ?? extractTokenFromUrl(data?.infolink) ?? undefined,
    };
  },

  async relinkAccount(
    creds: SmsToolsCredentials,
    unique: string,
    sid?: number,
  ): Promise<SmsToolsLinkResponse> {
    const base = deriveApiBase(creds.apiUrl);
    const data = await smsToolsRequest<SmsToolsLinkResponse & { already_connected?: boolean }>(
      base,
      "/create/wa.relink",
      { query: { secret: creds.secret, unique, sid } },
    );
    if ((data as { already_connected?: boolean } | null)?.already_connected) {
      throw new AppError(
        "La cuenta ya está activa y conectada. Para escanear un QR nuevo primero desvincúlala.",
        409,
      );
    }
    return {
      ...data,
      token: extractTokenFromUrl(data?.qrimagelink) ?? extractTokenFromUrl(data?.infolink) ?? undefined,
    };
  },

  async deleteAccount(creds: SmsToolsCredentials, unique: string) {
    const base = deriveApiBase(creds.apiUrl);
    return smsToolsRequest(base, "/delete/wa.account", {
      query: { secret: creds.secret, unique },
    });
  },

  async getQrImage(creds: SmsToolsCredentials, token: string): Promise<{ buffer: Buffer; contentType: string }> {
    const base = deriveApiBase(creds.apiUrl);
    return smsToolsRequest<{ buffer: Buffer; contentType: string }>(base, "/get/wa.qr", {
      query: { token },
      responseType: "binary",
    });
  },

  async getLinkInfo(creds: SmsToolsCredentials, token: string): Promise<unknown> {
    const base = deriveApiBase(creds.apiUrl);
    return smsToolsRequest<unknown>(base, "/get/wa.info", { query: { token } });
  },

  async getPending(creds: SmsToolsCredentials, page = 1, limit = 20): Promise<SmsToolsMessage[]> {
    const base = deriveApiBase(creds.apiUrl);
    const data = await smsToolsRequest<SmsToolsMessage[]>(base, "/get/wa.pending", {
      query: { secret: creds.secret, page, limit },
    });
    return Array.isArray(data) ? data : [];
  },

  async getSent(creds: SmsToolsCredentials, page = 1, limit = 20): Promise<SmsToolsMessage[]> {
    const base = deriveApiBase(creds.apiUrl);
    const data = await smsToolsRequest<SmsToolsMessage[]>(base, "/get/wa.sent", {
      query: { secret: creds.secret, page, limit },
    });
    return Array.isArray(data) ? data : [];
  },

  async getReceived(creds: SmsToolsCredentials, page = 1, limit = 20): Promise<SmsToolsMessage[]> {
    const base = deriveApiBase(creds.apiUrl);
    const data = await smsToolsRequest<SmsToolsMessage[]>(base, "/get/wa.received", {
      query: { secret: creds.secret, page, limit },
    });
    return Array.isArray(data) ? data : [];
  },

  async deleteSent(creds: SmsToolsCredentials, id: number | string) {
    const base = deriveApiBase(creds.apiUrl);
    return smsToolsRequest(base, "/delete/wa.sent", { query: { secret: creds.secret, id } });
  },

  async deleteReceived(creds: SmsToolsCredentials, id: number | string) {
    const base = deriveApiBase(creds.apiUrl);
    return smsToolsRequest(base, "/delete/wa.received", { query: { secret: creds.secret, id } });
  },

  /**
   * Envia un mensaje de texto via WhatsApp.
   * @param account  - unique del account SMS Tools (WhatsappConfig.account)
   * @param to       - numero destino en formato internacional sin "+" (e.g. "51987654321")
   * @param message  - texto del mensaje
   */
  async sendMessage(
    creds: SmsToolsCredentials,
    account: string,
    to: string,
    message: string,
  ): Promise<SmsToolsMessage> {
    const base = deriveApiBase(creds.apiUrl);
    const body = new URLSearchParams();
    body.set("secret", creds.secret);
    body.set("account", account);
    body.set("recipient", to);
    body.set("type", "text");
    body.set("message", message);
    return smsToolsRequest<SmsToolsMessage>(base, "/send/whatsapp", {
      method: "POST",
      body,
    });
  },

  /**
   * Envia un mensaje con adjunto (imagen, documento, video o audio) via WhatsApp.
   * Usado por el agente para enviar fichas de producto, multimedia y entrega.
   *
   * Formato del endpoint /send/whatsapp (replica el flujo probado de n8n):
   *  - imagen/video/audio → type="media",  media_type=<image|video|audio>, media_url
   *  - documento/pdf      → type="document", document_url, document_name, document_type
   * Se envia como multipart/form-data (la API lo exige para adjuntos). El `type`
   * NO es el kind directo: con `type=image` el gateway ignora el adjunto y manda
   * solo el caption como texto.
   * @param kind     - tipo de adjunto (image|document|video|audio)
   * @param mediaUrl - URL publica del recurso
   * @param caption  - texto opcional que acompaña al adjunto
   * @param fileName - nombre del archivo (documentos); se deriva del URL si falta
   */
  async sendMedia(
    creds: SmsToolsCredentials,
    account: string,
    to: string,
    kind: "image" | "document" | "video" | "audio",
    mediaUrl: string,
    caption?: string,
    fileName?: string,
  ): Promise<SmsToolsMessage> {
    const base = deriveApiBase(creds.apiUrl);
    const form = new FormData();
    form.set("secret", creds.secret);
    form.set("account", account);
    form.set("recipient", to);
    if (caption) form.set("message", caption);

    if (kind === "document") {
      const name = (fileName && fileName.trim()) || guessFileNameFromUrl(mediaUrl, "documento.pdf");
      form.set("type", "document");
      form.set("document_url", mediaUrl);
      form.set("document_name", name);
      form.set("document_type", name.toLowerCase().endsWith(".pdf") ? "pdf" : "file");
    } else {
      form.set("type", "media");
      form.set("media_type", kind); // image | video | audio
      form.set("media_url", mediaUrl);
    }

    return smsToolsRequest<SmsToolsMessage>(base, "/send/whatsapp", {
      method: "POST",
      body: form,
    });
  },
};

/** Deriva un nombre de archivo legible desde una URL (para document_name). */
function guessFileNameFromUrl(url: string, fallback: string): string {
  try {
    const path = new URL(url).pathname;
    const last = path.split("/").pop() ?? "";
    return decodeURIComponent(last) || fallback;
  } catch {
    return fallback;
  }
}

// -------------------------------------------------------------------------
// Parseo del webhook inbound de SMS Tools (mensajes entrantes de WhatsApp).
// SMS Tools envia el payload con nombres de campo variables segun version;
// normalizamos con cadenas de fallback igual que hacia el workflow n8n.
// -------------------------------------------------------------------------
export type InboundMessage = {
  /** id del mensaje en SMS Tools (idempotencia) */
  messageId: string | null;
  /** numero del CLIENTE que escribe, normalizado a digitos */
  fromPhone: string | null;
  /** numero del NEGOCIO (cuenta WhatsApp que recibio el mensaje); identifica al tenant */
  businessPhone: string | null;
  /** unique del account SMS Tools si viene en el payload (suele no venir en inbound) */
  account: string | null;
  /** texto del mensaje (puede ser caption de un adjunto) */
  text: string;
  /** tipo detectado */
  type: "text" | "image" | "video" | "document" | "audio";
  /** URL del adjunto si lo hay */
  mediaUrl: string | null;
  /** true si el mensaje lo emitio el propio negocio (eco/saliente): ignorar */
  fromMe: boolean;
  /** payload crudo para auditoria */
  raw: unknown;
};

/**
 * Busca un campo probando, para cada nombre base: data.<base>, el campo plano
 * con notacion de corchetes "data[<base>]" en el body, y body.<base>. Cubre
 * tanto el payload x-www-form-urlencoded de SMS Tools (data[wid]=...) ya
 * parseado a body.data.wid, como variantes JSON y planas.
 */
function field(
  body: Record<string, any>,
  data: Record<string, any>,
  bases: string[],
): string | null {
  for (const base of bases) {
    for (const candidate of [data?.[base], body?.[`data[${base}]`], body?.[base]]) {
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
      if (typeof candidate === "number") return String(candidate);
    }
  }
  return null;
}

export function parseInboundWebhook(raw: unknown): InboundMessage {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const data = (body.data && typeof body.data === "object" ? body.data : {}) as Record<string, any>;

  const messageId = field(body, data, ["id", "messageId", "message_id", "wamid", "uid", "msgid"]);

  // Cliente (remitente): NO usar wid (ese es el negocio).
  const fromRaw = field(body, data, ["phone", "from", "sender", "wa_id", "number", "remoteJid"]);
  const fromPhone = fromRaw ? fromRaw.replace(/\D/g, "") || null : null;

  // Negocio (cuenta que recibio): wid/emitter es el numero propio del negocio.
  const businessRaw = field(body, data, ["wid", "emitter", "to", "receiver"]);
  const businessPhone = businessRaw ? businessRaw.replace(/\D/g, "") || null : null;

  const account = field(body, data, ["account", "unique", "device"]);

  const text = field(body, data, ["message", "text", "body", "caption", "conversation"]) ?? "";

  const mediaUrl = field(body, data, [
    "media_url", "mediaUrl", "url", "image", "file_url", "download_url", "attachment", "media", "file", "document_url",
  ]);

  const rawType = (field(body, data, ["type", "message_type", "messageType", "msgtype", "msg_type"]) ?? "").toLowerCase();
  let type: InboundMessage["type"] = "text";
  if (rawType.includes("image") || rawType.includes("photo")) type = "image";
  else if (rawType.includes("video")) type = "video";
  else if (rawType.includes("doc") || rawType.includes("pdf") || rawType.includes("file")) type = "document";
  else if (rawType.includes("audio") || rawType.includes("voice") || rawType.includes("ptt")) type = "audio";
  else if (mediaUrl) type = "image"; // adjunto sin tipo claro -> asumimos imagen (comprobante)

  const fromMeRaw = (field(body, data, ["fromMe", "from_me", "self", "outgoing", "direction"]) ?? "").toLowerCase();
  const fromMe =
    fromMeRaw === "true" || fromMeRaw === "1" || fromMeRaw === "yes" || fromMeRaw === "outgoing" || fromMeRaw === "sent";

  return { messageId, fromPhone, businessPhone, account, text, type, mediaUrl, fromMe, raw };
}
