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
    const data = await smsToolsRequest<SmsToolsLinkResponse>(base, "/create/wa.relink", {
      query: { secret: creds.secret, unique, sid },
    });
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
};
