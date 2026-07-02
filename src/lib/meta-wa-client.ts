/**
 * Cliente mínimo de la API oficial de Meta WhatsApp Business (Cloud API).
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 *
 * Modelo: UNA app Meta de la plataforma (META_APP_SECRET / verify token en env)
 * y credenciales por tenant en WhatsappConfig (metaAccessToken de System User +
 * metaPhoneNumberId). Envío: POST /{phone_number_id}/messages con Bearer token.
 * La media saliente se manda por `link` (PUBLIC_BASE_URL debe ser HTTPS público
 * para que Meta pueda descargarla).
 */

import { AppError } from "./app-error";
import { env } from "../config/env";

export type MetaCredentials = {
  accessToken: string;
  phoneNumberId: string;
};

type GraphError = {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_data?: { details?: string };
};

/** Error 131047: fuera de la ventana de 24h (se requiere plantilla aprobada). */
export const META_REENGAGEMENT_CODE = 131047;

export const META_WINDOW_REASON =
  "Fuera de la ventana de 24h de WhatsApp (Meta): el cliente no escribió en las últimas 24 horas. " +
  "Solo puede enviarse una plantilla aprobada.";

function graphBase(): string {
  return `https://graph.facebook.com/${env.META_GRAPH_VERSION}`;
}

/** Extrae el código de error de Graph de un AppError lanzado por este cliente. */
export function graphErrorCode(err: unknown): number | null {
  if (err instanceof AppError && err.details && typeof err.details === "object") {
    const e = (err.details as { error?: GraphError }).error;
    if (e && typeof e.code === "number") return e.code;
  }
  return null;
}

export function isReengagementError(err: unknown): boolean {
  return graphErrorCode(err) === META_REENGAGEMENT_CODE;
}

async function graphRequest<T = unknown>(
  path: string,
  accessToken: string,
  options: { method?: "GET" | "POST"; body?: unknown; query?: Record<string, string> } = {},
): Promise<T> {
  const url = new URL(`${graphBase()}${path}`);
  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) url.searchParams.set(k, v);
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch (error) {
    throw new AppError(
      error instanceof Error
        ? `No se pudo conectar con la API de Meta: ${error.message}`
        : "No se pudo conectar con la API de Meta",
      502,
    );
  }

  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    // cuerpo no-JSON; se maneja abajo
  }

  if (!response.ok) {
    const e = ((json ?? {}) as { error?: GraphError }).error;
    const detail = e?.error_data?.details ? ` ${e.error_data.details}` : "";
    const msg = e?.message
      ? `Meta API: ${e.message}${detail}${e.code ? ` (código ${e.code})` : ""}`
      : `Meta API respondió ${response.status}`;
    if (e?.code === META_REENGAGEMENT_CODE) {
      throw new AppError(META_WINDOW_REASON, 422, json);
    }
    throw new AppError(msg, 502, json);
  }
  return json as T;
}

type SendResponse = { messages?: Array<{ id?: string }> };

function wamidOf(res: SendResponse): string | null {
  const id = res.messages?.[0]?.id;
  return id ? String(id) : null;
}

/** Solo dígitos: Meta espera el número en formato internacional sin "+" ni espacios. */
function normalizeTo(to: string): string {
  return to.replace(/\D/g, "");
}

export const metaWa = {
  /** Mensaje de texto libre (solo dentro de la ventana de 24h). */
  async sendText(creds: MetaCredentials, to: string, body: string): Promise<{ wamid: string | null }> {
    const res = await graphRequest<SendResponse>(`/${creds.phoneNumberId}/messages`, creds.accessToken, {
      method: "POST",
      body: {
        messaging_product: "whatsapp",
        to: normalizeTo(to),
        type: "text",
        text: { body, preview_url: true },
      },
    });
    return { wamid: wamidOf(res) };
  },

  /**
   * Media por link (imagen/video/audio/documento). Audio no soporta caption en
   * la Cloud API: si viene caption con audio, el caller debe mandarla aparte.
   */
  async sendMedia(
    creds: MetaCredentials,
    to: string,
    kind: "image" | "document" | "video" | "audio",
    mediaUrl: string,
    caption?: string,
    fileName?: string,
  ): Promise<{ wamid: string | null }> {
    const media: Record<string, string> = { link: mediaUrl };
    if (caption && kind !== "audio") media.caption = caption;
    if (fileName && kind === "document") media.filename = fileName;
    const res = await graphRequest<SendResponse>(`/${creds.phoneNumberId}/messages`, creds.accessToken, {
      method: "POST",
      body: {
        messaging_product: "whatsapp",
        to: normalizeTo(to),
        type: kind,
        [kind]: media,
      },
    });
    return { wamid: wamidOf(res) };
  },

  /**
   * Plantilla aprobada (única vía fuera de la ventana de 24h). `bodyParams` son
   * los valores posicionales {{1}}, {{2}}, ... del cuerpo de la plantilla.
   */
  async sendTemplate(
    creds: MetaCredentials,
    to: string,
    templateName: string,
    language: string,
    bodyParams: string[] = [],
  ): Promise<{ wamid: string | null }> {
    const res = await graphRequest<SendResponse>(`/${creds.phoneNumberId}/messages`, creds.accessToken, {
      method: "POST",
      body: {
        messaging_product: "whatsapp",
        to: normalizeTo(to),
        type: "template",
        template: {
          name: templateName,
          language: { code: language },
          ...(bodyParams.length
            ? {
                components: [
                  {
                    type: "body",
                    parameters: bodyParams.map((text) => ({ type: "text", text })),
                  },
                ],
              }
            : {}),
        },
      },
    });
    return { wamid: wamidOf(res) };
  },

  /**
   * La media entrante llega como `media id`; esto devuelve la URL temporal
   * (~5 min) que hay que descargar CON el mismo Bearer token.
   */
  async getMediaInfo(
    accessToken: string,
    mediaId: string,
  ): Promise<{ url: string; mimeType: string | null } | null> {
    try {
      const res = await graphRequest<{ url?: string; mime_type?: string }>(`/${mediaId}`, accessToken);
      if (!res.url) return null;
      return { url: res.url, mimeType: res.mime_type ?? null };
    } catch (err) {
      console.error("[meta-wa] getMediaInfo falló:", err instanceof Error ? err.message : err);
      return null;
    }
  },

  /**
   * Suscribe la app de la plataforma (la del token) al WABA, para que Meta
   * entregue los mensajes entrantes de ese número a NUESTRO webhook. Sin esto,
   * el WABA solo notifica a la app a la que estaba suscrito (con el número de
   * prueba, la app interna de Meta) y los mensajes reales nunca llegan.
   * POST /{wabaId}/subscribed_apps → { success: true }.
   */
  async subscribeAppToWaba(accessToken: string, wabaId: string): Promise<void> {
    await graphRequest(`/${wabaId}/subscribed_apps`, accessToken, { method: "POST" });
  },

  /** Valida credenciales y trae los datos del número (test de conexión). */
  async getPhoneNumberInfo(creds: MetaCredentials): Promise<{
    displayPhone: string | null;
    verifiedName: string | null;
    qualityRating: string | null;
  }> {
    const res = await graphRequest<{
      display_phone_number?: string;
      verified_name?: string;
      quality_rating?: string;
    }>(`/${creds.phoneNumberId}`, creds.accessToken, {
      query: { fields: "display_phone_number,verified_name,quality_rating" },
    });
    return {
      displayPhone: res.display_phone_number ?? null,
      verifiedName: res.verified_name ?? null,
      qualityRating: res.quality_rating ?? null,
    };
  },

  /** Plantillas del WABA (para los selectores de recordatorios/campañas). */
  async listTemplates(
    accessToken: string,
    wabaId: string,
  ): Promise<Array<{ name: string; language: string; status: string; category: string | null; bodyText: string | null; paramCount: number }>> {
    const res = await graphRequest<{
      data?: Array<{
        name?: string;
        language?: string;
        status?: string;
        category?: string;
        components?: Array<{ type?: string; text?: string }>;
      }>;
    }>(`/${wabaId}/message_templates`, accessToken, {
      query: { fields: "name,language,status,category,components", limit: "100" },
    });
    return (res.data ?? [])
      .filter((t) => t.name && t.language)
      .map((t) => {
        const body = (t.components ?? []).find((c) => String(c.type).toUpperCase() === "BODY");
        const bodyText = body?.text ?? null;
        const paramCount = bodyText ? new Set(bodyText.match(/\{\{\d+\}\}/g) ?? []).size : 0;
        return {
          name: t.name!,
          language: t.language!,
          status: String(t.status ?? "UNKNOWN").toUpperCase(),
          category: t.category ?? null,
          bodyText,
          paramCount,
        };
      });
  },
};
