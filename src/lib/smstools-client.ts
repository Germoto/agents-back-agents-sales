import { AppError } from "./app-error";
import { env } from "../config/env";
import { decodeEntities } from "./html-entities";
import { DOCUMENT_EXTS_LABEL, DOCUMENT_MIME, MAX_DOCUMENT_BYTES, MAX_DOCUMENT_MB, extOf, isDocumentExt } from "./document-types";

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
  body?: FormData | URLSearchParams | string | Buffer;
  headers?: Record<string, string>;
  responseType?: "json" | "binary";
  /** Corta la llamada pasado este tiempo (por defecto sin límite propio). */
  timeoutMs?: number;
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
      // Buffer es un Uint8Array válido como body en runtime; el tipo BodyInit
      // de lib.dom no lo incluye, de ahí el cast.
      body: options.body as BodyInit | undefined,
      headers: options.headers,
      signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
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

/** Identidad de un contacto de WhatsApp (API /api/lead/whatsapp, bajo demanda). */
export interface SmsToolsLeadInfo {
  jid?: string | null;
  phone?: string | null;
  /** true = contacto username con número oculto (phone es un pseudo-número LID). */
  is_lid?: boolean;
  /** Nombre que el contacto se puso en WhatsApp (mejor fuente para is_lid). */
  push_name?: string | null;
  first_name?: string | null;
  full_name?: string | null;
  business_name?: string | null;
  is_business?: boolean;
  /** Texto "about" del contacto. */
  status?: string | null;
  /** URL TEMPORAL de la foto de perfil (descargar para persistir). */
  avatar_url?: string | null;
  picture_id?: string | null;
}

/** Grupo de WhatsApp de la cuenta (API /api/get/wa.groups). El gid es estable. */
export interface SmsToolsGroup {
  gid: string;
  name: string;
}

/** Resultado por número de /api/groupadd/whatsapp, en el mismo orden enviado. */
export interface SmsToolsGroupAddResult {
  phone: string;
  /** added | invite_sent | already_in | invite_failed | cooldown | failed */
  status: string;
  code?: number;
}

export interface SmsToolsGroupParticipant {
  /** Solo dígitos: número real o pseudo-número LID (13 a 16 dígitos). */
  phone: string;
  lid: string | null;
  name: string | null;
  isAdmin: boolean;
  isSuperadmin: boolean;
}

export interface SmsToolsGroupInfo {
  gid: string;
  name: string | null;
  description: string | null;
  owner: string | null;
  participantCount: number;
  /** La cuenta del negocio es admin del grupo (requisito para agregar/sacar). */
  isAdmin: boolean;
  /** true = solo los admins pueden escribir. */
  announce: boolean;
  locked: boolean;
  isCommunity: boolean;
  suspended: boolean;
  watched: boolean;
  avatarUrl: string | null;
  participants: SmsToolsGroupParticipant[];
}

/** true si el destino es un grupo (…@g.us): no se limpia a dígitos al enviar. */
export function isGroupJid(value: string | null | undefined): boolean {
  return typeof value === "string" && /@g\.us$/i.test(value.trim());
}

/** Tope de números por llamada de groupadd (el gateway responde 400 si se pasa). */
export const GROUP_ADD_MAX_PHONES = 50;
// La llamada es síncrona: el gateway agrega uno por uno antes de responder.
const GROUP_ADD_TIMEOUT_MS = 150_000;

/** Opciones de envío: cita y, en grupos, menciones. */
export type SmsToolsSendOpts = {
  quoteWamid?: string | null;
  /** "" = el cliente (1 a 1), "me" = mensaje propio, o el número del autor (grupos). */
  quoteFrom?: string;
  /** Números mencionados (solo dígitos). El texto debe incluir @<número>. */
  mentions?: string[];
};

export const smsTools = {
  /** Grupos de la cuenta de WhatsApp (`unique`). Lanza si el gateway falla. */
  async getGroups(creds: SmsToolsCredentials, unique: string): Promise<SmsToolsGroup[]> {
    const base = deriveApiBase(creds.apiUrl);
    const body = new URLSearchParams({ secret: creds.secret, unique });
    const data = await smsToolsRequest<SmsToolsGroup[]>(base, "/get/wa.groups", {
      method: "POST",
      body,
      timeoutMs: 30_000,
    });
    if (!Array.isArray(data)) return [];
    return data
      .filter((g) => g && typeof g.gid === "string" && g.gid)
      .map((g) => ({ gid: g.gid, name: typeof g.name === "string" && g.name.trim() ? g.name.trim() : g.gid }));
  },

  /**
   * Agrega números a un grupo (máx. 50). La cuenta debe ser admin del grupo; si
   * no lo es, el gid no existe o la cuenta está desconectada, el gateway responde
   * 500 y esto lanza. `invite` = si la privacidad del contacto impide agregarlo,
   * se le envía la invitación por privado.
   */
  async addToGroup(
    creds: SmsToolsCredentials,
    unique: string,
    gid: string,
    phones: string[],
    invite = true,
    action: "add" | "remove" = "add",
  ): Promise<SmsToolsGroupAddResult[]> {
    if (phones.length === 0) return [];
    if (phones.length > GROUP_ADD_MAX_PHONES) {
      throw new AppError(`Máximo ${GROUP_ADD_MAX_PHONES} números por llamada.`, 400);
    }
    const base = deriveApiBase(creds.apiUrl);
    const body = new URLSearchParams({
      secret: creds.secret,
      unique,
      gid,
      phones: phones.join(","),
      invite: invite ? "1" : "0",
    });
    // Sin `action` el gateway agrega (compatibilidad): solo viaja al sacar.
    if (action === "remove") body.set("action", "remove");
    const data = await smsToolsRequest<SmsToolsGroupAddResult[]>(base, "/groupadd/whatsapp", {
      method: "POST",
      body,
      timeoutMs: GROUP_ADD_TIMEOUT_MS,
    });
    return Array.isArray(data) ? data : [];
  },

  /**
   * Detalle de un grupo: nombre, descripción, si la cuenta es admin, si solo
   * escriben admins (`announce`) y la lista de participantes. Lanza si falla.
   */
  async getGroupInfo(creds: SmsToolsCredentials, unique: string, gid: string): Promise<SmsToolsGroupInfo | null> {
    const base = deriveApiBase(creds.apiUrl);
    const body = new URLSearchParams({ secret: creds.secret, unique, gid });
    const data = await smsToolsRequest<Record<string, any> | null>(base, "/groupinfo/whatsapp", {
      method: "POST",
      body,
      timeoutMs: 30_000,
    });
    if (!data || typeof data !== "object") return null;
    const flag = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";
    const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const participants: SmsToolsGroupParticipant[] = (Array.isArray(data.participants) ? data.participants : [])
      .filter((p: any) => p && (typeof p.phone === "string" || typeof p.phone === "number"))
      .map((p: any) => ({
        // Número real o pseudo-número LID: se usa tal cual como clave (solo dígitos).
        phone: String(p.phone).replace(/\D/g, ""),
        lid: text(p.lid),
        name: text(p.name),
        isAdmin: flag(p.is_admin) || flag(p.is_superadmin),
        isSuperadmin: flag(p.is_superadmin),
      }))
      .filter((p: SmsToolsGroupParticipant) => p.phone);
    return {
      gid: text(data.gid) ?? gid,
      name: text(data.name),
      description: text(data.description),
      owner: text(data.owner),
      participantCount: Number(data.participant_count) || participants.length,
      isAdmin: flag(data.is_admin),
      announce: flag(data.announce),
      locked: flag(data.locked),
      isCommunity: flag(data.is_community),
      suspended: flag(data.suspended),
      watched: flag(data.watched),
      avatarUrl: asHttpUrl(text(data.avatar_url)),
      participants,
    };
  },

  /**
   * Enciende/apaga la vigilancia de un grupo: solo los grupos vigilados mandan
   * sus mensajes por webhook (`whatsapp_group`). La cuenta debe estar en el grupo.
   */
  async watchGroup(creds: SmsToolsCredentials, unique: string, gid: string, watch: boolean): Promise<boolean> {
    const base = deriveApiBase(creds.apiUrl);
    const body = new URLSearchParams({ secret: creds.secret, unique, gid, watch: watch ? "1" : "0" });
    const data = await smsToolsRequest<{ watched?: unknown } | null>(base, "/groupwatch/whatsapp", {
      method: "POST",
      body,
      timeoutMs: 30_000,
    });
    const w = data?.watched;
    return w === undefined || w === null ? watch : w === true || w === 1 || w === "1" || w === "true";
  },

  /**
   * Datos de identidad de un lead (nombre, foto, LID, negocio). Best-effort:
   * devuelve null si no hay datos (404) o ante cualquier error — nunca lanza.
   */
  async getLeadInfo(
    creds: SmsToolsCredentials,
    unique: string,
    phone: string,
  ): Promise<SmsToolsLeadInfo | null> {
    try {
      const base = deriveApiBase(creds.apiUrl);
      const body = new URLSearchParams({ secret: creds.secret, unique, phone });
      const data = await smsToolsRequest<SmsToolsLeadInfo | null>(base, "/lead/whatsapp", {
        method: "POST",
        body,
      });
      return data && typeof data === "object" ? data : null;
    } catch (err) {
      console.warn("[smstools] getLeadInfo falló:", err instanceof Error ? err.message : err);
      return null;
    }
  },

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
   * Envía una ENCUESTA nativa de WhatsApp (botonera): el cliente elige con un tap
   * y el voto llega por el webhook normal como texto = opción elegida, con
   * poll_wamid (id de la encuesta). Pregunta ≤255 chars; 2-12 opciones ≤100 chars,
   * distintas entre sí; selectable 1 = selección única. priority=1 (síncrono).
   */
  async sendPoll(
    creds: SmsToolsCredentials,
    account: string,
    to: string,
    poll: { question: string; options: string[]; selectable?: number },
  ): Promise<SmsToolsMessage> {
    const base = deriveApiBase(creds.apiUrl);
    const body = new URLSearchParams();
    body.set("secret", creds.secret);
    body.set("account", account);
    body.set("recipient", to);
    body.set("type", "poll");
    body.set("message", "");
    body.set("poll_name", poll.question);
    body.set("poll_options", JSON.stringify(poll.options));
    body.set("poll_selectable", String(Math.max(1, poll.selectable ?? 1)));
    body.set("priority", "1");
    return smsToolsRequest<SmsToolsMessage>(base, "/send/whatsapp", {
      method: "POST",
      body,
    });
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
    opts?: SmsToolsSendOpts,
  ): Promise<SmsToolsMessage> {
    const base = deriveApiBase(creds.apiUrl);
    const body = new URLSearchParams();
    body.set("secret", creds.secret);
    body.set("account", account);
    body.set("recipient", to);
    body.set("type", "text");
    body.set("message", message);
    // Responder citando: wamid del mensaje citado + quién lo escribió ("" =
    // cliente, "me" = mensaje propio del bot/asesor; en grupos, el número del autor).
    if (opts?.quoteWamid) {
      body.set("quote_wamid", opts.quoteWamid);
      body.set("quote_from", opts.quoteFrom ?? "");
    }
    // Menciones (grupos): números separados por coma; el texto ya trae @<número>.
    if (opts?.mentions?.length) body.set("mentions", opts.mentions.join(","));
    return smsToolsRequest<SmsToolsMessage>(base, "/send/whatsapp", {
      method: "POST",
      body,
    });
  },

  /**
   * Reacciona con un emoji a un mensaje del chat (reaction "" = quitar la
   * reacción). fromMe=true cuando el mensaje reaccionado es propio (bot/asesor);
   * el wamid es el de WhatsApp (data[wamid] del inbound o aprendido del status).
   */
  async sendReaction(
    creds: SmsToolsCredentials,
    account: string,
    opts: { recipient: string; wamid: string; reaction: string; fromMe: boolean },
  ): Promise<unknown> {
    const base = deriveApiBase(creds.apiUrl);
    const body = new URLSearchParams();
    body.set("secret", creds.secret);
    body.set("unique", account);
    body.set("recipient", opts.recipient);
    body.set("wamid", opts.wamid);
    body.set("reaction", opts.reaction);
    body.set("from_me", opts.fromMe ? "1" : "0");
    return smsToolsRequest<unknown>(base, "/react/whatsapp", { method: "POST", body });
  },

  /**
   * Dispara el indicador "escribiendo…" (composing), "grabando audio…"
   * (recording) o lo corta (paused) en el WhatsApp del cliente. Best-effort:
   * WhatsApp lo expira solo a los ~10s; el envío de un mensaje también lo corta.
   */
  async sendTyping(
    creds: SmsToolsCredentials,
    account: string,
    opts: { recipient: string; state: TypingState },
  ): Promise<unknown> {
    const base = deriveApiBase(creds.apiUrl);
    const body = new URLSearchParams();
    body.set("secret", creds.secret);
    body.set("unique", account);
    body.set("recipient", opts.recipient);
    body.set("state", opts.state);
    return smsToolsRequest<unknown>(base, "/typing/whatsapp", { method: "POST", body });
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
    kind: "image" | "document" | "video" | "audio" | "sticker",
    mediaUrl: string,
    caption?: string,
    fileName?: string,
    opts?: SmsToolsSendOpts,
  ): Promise<SmsToolsMessage> {
    const base = deriveApiBase(creds.apiUrl);

    // La API exige multipart/form-data construido "a mano": con el FormData estándar
    // (undici) responde { status: 400, message: "Invalid Parameters!" }. Replicamos el
    // multipart manual probado del workflow n8n. `message` es obligatorio para TODOS
    // los tipos, así que si no hay caption mandamos un espacio.
    const fields: Record<string, string> = {
      secret: creds.secret,
      account,
      // Un grupo (…@g.us) viaja tal cual; un número se limpia a dígitos.
      recipient: isGroupJid(to) ? to.trim() : to.replace(/\D/g, ""),
      type: kind === "document" ? "document" : "media",
      // `message` es OBLIGATORIO para todos los tipos (si falta: "Invalid Parameters!").
      // Los stickers no llevan caption (el gateway lo ignora) pero el campo debe viajar:
      // buildMultipart omite los vacíos, así que va un espacio igual que en media sin texto.
      message: kind === "sticker" ? " " : (caption && caption.trim()) || " ",
      // "1" (default) = síncrono: el gateway descarga/emite la media ANTES de
      // responder → el orden de las secuencias queda garantizado (el texto iba
      // inmediato y con "2" en cola lo adelantaba). Kill-switch por env.
      priority: env.SMSTOOLS_MEDIA_PRIORITY,
    };
    if (opts?.quoteWamid) {
      fields.quote_wamid = opts.quoteWamid;
      if (opts.quoteFrom) fields.quote_from = opts.quoteFrom;
    }
    if (opts?.mentions?.length) fields.mentions = opts.mentions.join(",");

    if (kind === "document") {
      // Documentos (pdf, zip, xlsx, …): document_type = extensión del catálogo (el gateway
      // lo exige; otro valor → 400) y document_name = nombre visible para el cliente.
      const name = (fileName && fileName.trim()) || guessFileNameFromUrl(mediaUrl, "documento.pdf");
      const ext = extOf(name) || extOf(mediaUrl);
      if (!isDocumentExt(ext)) {
        throw new AppError(
          `WhatsApp no admite archivos .${ext || "?"}. Se admiten: ${DOCUMENT_EXTS_LABEL}.`,
          422,
        );
      }
      fields.document_type = ext;
      fields.document_name = name;

      // Hasta INLINE_DOCUMENT_MAX_BYTES va como BINARIO (document_file): el gateway
      // recibe el nombre y el Content-Type reales (con document_url hacía sniffing y
      // un .xlsx llegaba como application/zip). Más grande → document_url (el gateway
      // lo descarga él; no lo cargamos en RAM). Más que MAX_DOCUMENT_MB → error claro.
      let fileData: Buffer | null = null;
      try {
        const res = await fetch(mediaUrl);
        if (res.ok) {
          const declared = Number(res.headers.get("content-length") ?? 0);
          if (declared > MAX_DOCUMENT_BYTES) {
            await res.body?.cancel().catch(() => undefined);
            throw new AppError(
              `El archivo (${(declared / (1024 * 1024)).toFixed(1)} MB) supera el tope de ${MAX_DOCUMENT_MB} MB de WhatsApp.`,
              422,
            );
          }
          if (declared > INLINE_DOCUMENT_MAX_BYTES) {
            await res.body?.cancel().catch(() => undefined);
          } else {
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length > MAX_DOCUMENT_BYTES) {
              throw new AppError(`El archivo supera el tope de ${MAX_DOCUMENT_MB} MB de WhatsApp.`, 422);
            }
            fileData = buf.length > INLINE_DOCUMENT_MAX_BYTES ? null : buf;
          }
        }
      } catch (err) {
        if (err instanceof AppError) throw err;
        /* fallback por URL abajo */
      }

      if (fileData) {
        const { body, contentType } = buildMultipart(fields, [
          {
            name: "document_file",
            filename: name,
            contentType: DOCUMENT_MIME[ext],
            data: fileData,
          },
        ]);
        return smsToolsRequest<SmsToolsMessage>(base, "/send/whatsapp", {
          method: "POST",
          body,
          headers: { "Content-Type": contentType },
        });
      }

      // Por URL: el gateway descarga el archivo (archivos grandes o si no se pudo leer).
      fields.document_url = mediaUrl;
    } else {
      fields.media_type = kind; // image | video | audio | sticker (.webp 512×512)
      fields.media_url = mediaUrl;
    }

    const { body, contentType } = buildMultipart(fields);
    return smsToolsRequest<SmsToolsMessage>(base, "/send/whatsapp", {
      method: "POST",
      body,
      headers: { "Content-Type": contentType },
    });
  },
};

/**
 * Arma un cuerpo multipart/form-data manualmente con boundary explícito. Necesario
 * porque /send/whatsapp rechaza el multipart del FormData estándar ("Invalid
 * Parameters!"). Campos vacíos se omiten.
 */
type MultipartFile = { name: string; filename: string; contentType: string; data: Buffer };

function buildMultipart(
  fields: Record<string, string | undefined | null>,
  files: MultipartFile[] = [],
): { body: Buffer; contentType: string } {
  const boundary = `----salesAgentBoundary${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [key, raw] of Object.entries(fields)) {
    if (raw === undefined || raw === null || raw === "") continue;
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${String(raw)}\r\n`,
        "utf8",
      ),
    );
  }
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
        "utf8",
      ),
      file.data,
      Buffer.from("\r\n", "utf8"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Hasta este tamaño el documento viaja como binario (document_file); más grande, por URL. */
const INLINE_DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;

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
  type: "text" | "image" | "video" | "document" | "audio" | "sticker";
  /** URL del adjunto si lo hay */
  mediaUrl: string | null;
  /** Nombre del documento adjunto si el gateway lo manda (document_name/filename) */
  fileName: string | null;
  /** true si el mensaje lo emitio el propio negocio (eco/saliente): ignorar */
  fromMe: boolean;
  // --- Atribución de anuncios Meta CTWA (SOLO en el primer mensaje del lead) ---
  /** ID del anuncio de Meta que originó el chat (clave de atribución) */
  adSourceId: string | null;
  /** Titular del creativo (identificación humana) */
  adTitle: string | null;
  /** Click-ID (~130 chars) — guardar ÍNTEGRO: token de Meta Conversions API */
  ctwaClid: string | null;
  /** URL del anuncio (fb.me/…) */
  adSourceUrl: string | null;
  /** wamid de WhatsApp del PROPIO mensaje entrante (ancla de reacciones/citas a mensajes del cliente) */
  wamid: string | null;
  /** Reacción emoji: wamid del mensaje al que reaccionó el cliente */
  targetWamid: string | null;
  /** Respuesta citando: wamid del mensaje citado */
  quotedWamid: string | null;
  /** Voto de una encuesta nativa: wamid de la ENCUESTA respondida (text = opción elegida) */
  pollWamid: string | null;
  /** payload crudo para auditoria */
  raw: unknown;
};

/** Estado de entrega recibido por webhook (type: "whatsapp_status"). */
export type DeliveryStatusEvent = {
  messageId: string | null;
  wamid: string | null;
  status: string;
  /** Destinatario del mensaje; en mensajes a grupos es el gid (…@g.us, sin "+"). */
  phone: string | null;
};

/** Estado del indicador de escritura (webhook whatsapp_typing y POST /typing). */
export type TypingState = "composing" | "recording" | "paused";

/** Evento efímero "el cliente está escribiendo/grabando" (type: "whatsapp_typing"). */
export type TypingEvent = {
  /** Teléfono del cliente (solo dígitos; puede ser pseudo-número LID). */
  phone: string;
  /** Cuenta WA que lo recibió (unique/account), si el gateway la incluye. */
  account: string | null;
  state: TypingState;
};

/**
 * Si el webhook es un evento de TYPING del cliente (type: "whatsapp_typing"),
 * lo parsea; si no, devuelve null (el caller sigue con status/mensaje). Señal
 * efímera: NUNCA se persiste — solo se reenvía al panel por socket.
 */
export function parseTypingWebhook(raw: unknown): TypingEvent | null {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  if (String(body.type ?? "").toLowerCase() !== "whatsapp_typing") return null;
  const data = (body.data && typeof body.data === "object" ? body.data : {}) as Record<string, any>;
  const phone = (field(body, data, ["phone", "from", "sender"]) ?? "").replace(/\D/g, "");
  if (!phone) return null;
  const rawState = (field(body, data, ["state"]) ?? "").toLowerCase();
  // Estado desconocido → "paused": ante la duda, ocultar el indicador.
  const state: TypingState = rawState === "composing" || rawState === "recording" ? rawState : "paused";
  return { phone, account: field(body, data, ["account", "unique", "device"]), state };
}

/**
 * Si el webhook es un evento de ESTADO de entrega (type: "whatsapp_status"),
 * lo parsea; si no, devuelve null (el caller sigue con el flujo de mensaje).
 */
export function parseStatusWebhook(raw: unknown): DeliveryStatusEvent | null {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  if (String(body.type ?? "").toLowerCase() !== "whatsapp_status") return null;
  const data = (body.data && typeof body.data === "object" ? body.data : {}) as Record<string, any>;
  const status = (field(body, data, ["status"]) ?? "").toLowerCase();
  if (!status) return null;
  return {
    messageId: field(body, data, ["id", "messageId", "message_id"]),
    wamid: field(body, data, ["wamid"]),
    status,
    phone: field(body, data, ["phone"]),
  };
}

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

/** Valor del webhook que de verdad es una URL descargable (http/https); el resto ("0", "", "false") → null. */
function asHttpUrl(value: string | null): string | null {
  return value && /^https?:\/\/\S+$/i.test(value) ? value : null;
}

/** Tipo inferido de la extensión de la URL (cuando no hay type ni mimetype). */
function typeFromUrl(url: string): InboundMessage["type"] {
  const u = url.toLowerCase().split(/[?#]/)[0];
  if (isDocumentExt(extOf(u))) return "document";
  if (/\.(mp4|mov|webm|mkv|avi|3gp)$/.test(u)) return "video";
  if (/\.(ogg|opus|mp3|m4a|aac|wav)$/.test(u)) return "audio";
  // El gateway entrega los stickers por el webhook normal con attachment=URL .webp.
  if (/\.webp$/.test(u)) return "sticker";
  return "image";
}

// ---------------------------------------------------------------------------
// Webhooks de GRUPOS (type: whatsapp_group / whatsapp_group_event). Un mensaje
// de grupo NO es un lead: jamás debe llegar al flujo 1 a 1 (crearía un cliente
// falso y el bot respondería).
// ---------------------------------------------------------------------------

/** Mensaje (o reacción) de un grupo vigilado. */
export type GroupMessageEvent = {
  gid: string;
  /** Cuenta WA que lo recibió, si el gateway la incluye. */
  account: string | null;
  wamid: string | null;
  /** Autor, solo dígitos (número real o pseudo-número LID). */
  authorPhone: string;
  authorName: string | null;
  /** true = lo escribió el dueño desde su teléfono. */
  fromMe: boolean;
  text: string;
  mediaUrl: string | null;
  mediaType: InboundMessage["type"] | null;
  quotedWamid: string | null;
  /** Solo en reacciones: wamid del mensaje reaccionado. */
  targetWamid: string | null;
  mentions: string[];
  timestamp: Date | null;
  raw: unknown;
};

/** Evento de participantes o de datos del grupo. */
export type GroupParticipantEvent = {
  gid: string;
  account: string | null;
  action: "join" | "leave" | "promote" | "demote" | "update";
  /** Afectados, solo dígitos (vacío en update). */
  phones: string[];
  by: string | null;
  reason: string | null;
  name: string | null;
  topic: string | null;
  timestamp: Date | null;
};

function webhookParts(raw: unknown): { body: Record<string, any>; data: Record<string, any>; type: string } {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const data = (body.data && typeof body.data === "object" ? body.data : {}) as Record<string, any>;
  return { body, data, type: String(body.type ?? "").toLowerCase() };
}

function digitList(value: string | null): string[] {
  if (!value) return [];
  return [...new Set(value.split(",").map((p) => p.replace(/\D/g, "")).filter(Boolean))];
}

function epochDate(value: string | null): Date | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Segundos (contrato) o milisegundos, por si el gateway cambia.
  const d = new Date(n > 1e12 ? n : n * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * true si el payload pertenece a un grupo (por tipo, por `gid` o porque el
 * remitente es …@g.us). Barrera del receptor: lo que dé true NUNCA entra al
 * flujo de mensajes 1 a 1, se haya podido interpretar o no.
 */
export function isGroupWebhook(raw: unknown): boolean {
  const { body, data, type } = webhookParts(raw);
  if (type.startsWith("whatsapp_group")) return true;
  if (isGroupJid(field(body, data, ["gid"]))) return true;
  return isGroupJid(field(body, data, ["phone", "from", "sender", "remoteJid", "recipient"]));
}

/** Tipo declarado del webhook (minúsculas), para descartar eventos que no son mensajes. */
export function webhookType(raw: unknown): string {
  return webhookParts(raw).type;
}

/** Mensaje de grupo (type: "whatsapp_group"); null si no lo es o viene incompleto. */
export function parseGroupMessageWebhook(raw: unknown): GroupMessageEvent | null {
  const { body, data, type } = webhookParts(raw);
  if (type !== "whatsapp_group") return null;
  const gid = field(body, data, ["gid"]);
  if (!gid || !isGroupJid(gid)) return null;
  const authorPhone = (field(body, data, ["phone", "from", "sender"]) ?? "").replace(/\D/g, "");
  const fromMeRaw = (field(body, data, ["from_me", "fromMe"]) ?? "").toLowerCase();
  const mediaUrl = asHttpUrl(field(body, data, ["attachment", "media_url", "mediaUrl"]));
  return {
    gid: gid.trim(),
    account: field(body, data, ["account", "unique", "device"]),
    wamid: field(body, data, ["wamid"]),
    authorPhone,
    authorName: field(body, data, ["name"]),
    fromMe: fromMeRaw === "1" || fromMeRaw === "true",
    text: decodeEntities(field(body, data, ["message", "text", "caption"]) ?? ""),
    mediaUrl,
    mediaType: mediaUrl ? typeFromUrl(mediaUrl) : null,
    quotedWamid: field(body, data, ["quoted_wamid"]),
    targetWamid: field(body, data, ["target_wamid"]),
    mentions: digitList(field(body, data, ["mentions"])),
    timestamp: epochDate(field(body, data, ["timestamp"])),
    raw,
  };
}

/** Evento de grupo (type: "whatsapp_group_event"); null si no lo es o no se reconoce. */
export function parseGroupEventWebhook(raw: unknown): GroupParticipantEvent | null {
  const { body, data, type } = webhookParts(raw);
  if (type !== "whatsapp_group_event") return null;
  const gid = field(body, data, ["gid"]);
  if (!gid || !isGroupJid(gid)) return null;
  const action = (field(body, data, ["action"]) ?? "").toLowerCase();
  if (!["join", "leave", "promote", "demote", "update"].includes(action)) return null;
  return {
    gid: gid.trim(),
    account: field(body, data, ["account", "unique", "device"]),
    action: action as GroupParticipantEvent["action"],
    phones: digitList(field(body, data, ["phones"])),
    by: (field(body, data, ["by"]) ?? "").replace(/\D/g, "") || null,
    reason: field(body, data, ["reason"]),
    name: field(body, data, ["name"]),
    topic: field(body, data, ["topic"]),
    timestamp: epochDate(field(body, data, ["timestamp"])),
  };
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

  // Entidades HTML (`&quot;`, `&amp;`) que el gateway pueda escapar: se decodifican para que
  // el modelo no las copie en sus respuestas.
  const text = decodeEntities(field(body, data, ["message", "text", "body", "caption", "conversation"]) ?? "");
  const hasText = text.trim().length > 0;

  // Campos ADJUNTO-específicos: si vienen, es un adjunto real (nunca foto de perfil).
  // Solo cuenta si es una URL http(s): SMS Tools manda `attachment: 0` en TODOS los
  // mensajes de texto (visto el 30-oct-2026) y ese "0" convertía cada texto en una
  // "imagen" que no se podía descargar ni leer (visión 400, adjunto roto en el panel).
  const attachmentUrl = asHttpUrl(
    field(body, data, ["media_url", "mediaUrl", "file_url", "download_url", "attachment", "document_url", "media"]),
  );
  // Campos AMBIGUOS: SMS Tools manda la foto de perfil del remitente en image/url
  // en TODOS los inbound (incluidos los de texto) → solo son adjunto si NO hay texto.
  const ambiguousUrl = asHttpUrl(field(body, data, ["image", "url", "file", "photo", "picture"]));

  const rawType = (field(body, data, ["type", "message_type", "messageType", "msgtype", "msg_type"]) ?? "").toLowerCase();
  const typeFromRaw = (): InboundMessage["type"] | null => {
    if (rawType.includes("sticker")) return "sticker";
    if (rawType.includes("image") || rawType.includes("photo")) return "image";
    if (rawType.includes("video")) return "video";
    if (rawType.includes("doc") || rawType.includes("pdf") || rawType.includes("file")) return "document";
    if (rawType.includes("audio") || rawType.includes("voice") || rawType.includes("ptt")) return "audio";
    return null;
  };

  // Mimetype del adjunto (si SMS Tools lo manda): señal FUERTE de adjunto real, incluso
  // con caption (un mensaje de texto con foto de perfil no trae mimetype).
  const mime = (field(body, data, ["mimetype", "mime", "mime_type", "content_type", "contentType"]) ?? "").toLowerCase();
  const typeFromMime = (): InboundMessage["type"] | null => {
    // WhatsApp manda los stickers como image/webp; las fotos llegan como jpeg.
    if (mime === "image/webp") return "sticker";
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    if (mime.includes("pdf") || mime.startsWith("application/") || mime.startsWith("text/")) return "document";
    return null;
  };


  // Detección robusta (no depende del valor exacto de data[type] de SMS Tools):
  // 1) tipo media explícito o mimetype → ese tipo (con o sin caption);
  // 2) campo adjunto-específico (attachment/media/...) → adjunto real AUNQUE haya
  //    caption (esos campos nunca traen la foto de perfil);
  // 3) campo ambiguo (image/url) SIN texto → imagen sola (comprobante). Con texto se
  //    ignora: ahí SMS Tools manda la foto de perfil del remitente.
  const mediaType = typeFromRaw() ?? typeFromMime();
  let type: InboundMessage["type"] = "text";
  let mediaUrl: string | null = null;
  if (mediaType) {
    type = mediaType;
    mediaUrl = attachmentUrl ?? ambiguousUrl;
  } else if (attachmentUrl) {
    type = typeFromUrl(attachmentUrl);
    mediaUrl = attachmentUrl;
  } else if (!hasText && ambiguousUrl) {
    type = typeFromUrl(ambiguousUrl);
    mediaUrl = ambiguousUrl;
  }

  const fromMeRaw = (field(body, data, ["fromMe", "from_me", "self", "outgoing", "direction"]) ?? "").toLowerCase();
  const fromMe =
    fromMeRaw === "true" || fromMeRaw === "1" || fromMeRaw === "yes" || fromMeRaw === "outgoing" || fromMeRaw === "sent";

  // Diagnóstico: qué tipo trae SMS Tools y qué detectamos (sin volcar datos).
  console.log(
    `[inbound] rawType="${rawType}" mime="${mime}" detected=${type} media=${mediaUrl ? "yes" : "no"} hasText=${hasText} keys=${Object.keys(data).join(",") || Object.keys(body).join(",")}`,
  );

  return {
    messageId,
    fromPhone,
    businessPhone,
    account,
    text,
    type,
    mediaUrl: type === "text" ? null : mediaUrl,
    fileName: type === "document" ? (field(body, data, ["filename", "file_name", "document_name", "media_name", "name"]) ?? null) : null,
    fromMe,
    // Atribución CTWA: solo puebla el primer mensaje del lead; vacío = null.
    adSourceId: field(body, data, ["ad_source_id"]),
    adTitle: field(body, data, ["ad_title"]),
    ctwaClid: field(body, data, ["ctwa_clid"]),
    adSourceUrl: field(body, data, ["ad_source_url"]),
    // wamid propio + reacción emoji / respuesta citando (anclan por wamid).
    wamid: field(body, data, ["wamid"]),
    targetWamid: field(body, data, ["target_wamid"]),
    quotedWamid: field(body, data, ["quoted_wamid"]),
    pollWamid: field(body, data, ["poll_wamid"]),
    raw,
  };
}
