import { AppError } from "./app-error";
import { env } from "../config/env";

/**
 * Minimal HTTP client for the SMS TOOLS Admin API.
 * Docs: https://smstools.pro/dashboard/docs/admin
 *
 * Base URL example: https://smstools.pro/admin
 * Auth via `token` form/query parameter (System token from system settings).
 */

export type SmsToolsAdminCreateUserPayload = {
  name: string;
  email: string;
  password: string;
  credits?: number;
  timezone?: string;
  country?: string;
  language?: number;
  theme?: "light" | "dark";
  role?: number; // role id; default user role
};

export type SmsToolsAdminApiKey = {
  id: number;
  secret: string;
};

type Envelope<T> = {
  status: number;
  message?: string;
  data: T;
};

function adminBase(): string {
  return env.SMSTOOLS_ADMIN_URL.replace(/\/+$/, "");
}

function adminToken(): string {
  if (!env.SMSTOOLS_ADMIN_TOKEN) {
    throw new AppError(
      "SMSTOOLS_ADMIN_TOKEN no está configurado en el servidor.",
      500,
    );
  }
  return env.SMSTOOLS_ADMIN_TOKEN;
}

async function postForm<T>(path: string, fields: Record<string, string | number | string[]>): Promise<T> {
  const form = new FormData();
  form.append("token", adminToken());
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) form.append(`${key}[]`, String(v));
    } else {
      form.append(key, String(value));
    }
  }

  const url = `${adminBase()}${path}`;
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", body: form });
  } catch (error) {
    throw new AppError(
      error instanceof Error
        ? `No se pudo conectar con la API de admin de SMS TOOLS: ${error.message}`
        : "No se pudo conectar con la API de admin de SMS TOOLS",
      502,
    );
  }

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    throw new AppError("La API de admin de SMS TOOLS respondió con error.", 502, parsed ?? { text });
  }

  const env_ = parsed as Envelope<T> | null;
  if (env_ && typeof env_ === "object" && typeof env_.status === "number" && env_.status >= 400) {
    throw new AppError(env_.message ?? "Error de la API de admin de SMS TOOLS.", 502, env_);
  }
  return (env_?.data as T) ?? (parsed as T);
}

async function getJson<T>(path: string, query: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(`${adminBase()}${path}`);
  url.searchParams.set("token", adminToken());
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), { method: "GET" });
  } catch (error) {
    throw new AppError(
      error instanceof Error
        ? `No se pudo conectar con la API de admin de SMS TOOLS: ${error.message}`
        : "No se pudo conectar con la API de admin de SMS TOOLS",
      502,
    );
  }

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    throw new AppError("La API de admin de SMS TOOLS respondió con error.", 502, parsed ?? { text });
  }

  const env_ = parsed as Envelope<T> | null;
  if (env_ && typeof env_ === "object" && typeof env_.status === "number" && env_.status >= 400) {
    throw new AppError(env_.message ?? "Error de la API de admin de SMS TOOLS.", 502, env_);
  }
  return (env_?.data as T) ?? (parsed as T);
}

/**
 * Default API key permissions granted to every tenant when provisioning.
 * Source: https://smstools.pro/dashboard/docs/admin#tag/API-Keys/paths/~1create~1apikey/post
 */
export const DEFAULT_API_KEY_PERMISSIONS = [
  "otp",
  "sms_send",
  "sms_send_bulk",
  "wa_send",
  "wa_send_bulk",
  "ussd",
  "validate_wa_phone",
  "get_credits",
  "get_earnings",
  "get_subscription",
  "get_sms_pending",
  "get_wa_pending",
  "get_sms_received",
  "get_wa_received",
  "get_sms_sent",
  "get_sms_campaigns",
  "get_wa_sent",
  "get_wa_campaigns",
  "get_contacts",
  "get_groups",
  "get_ussd",
  // "get_notifications" — not supported in this SMS Tools instance
  "get_wa_accounts",
  "get_wa_groups",
  "get_devices",
  "get_rates",
  "get_shorteners",
  "get_unsubscribed",
  "create_whatsapp",
  "create_contact",
  "create_group",
  "start_sms_campaign",
  "stop_sms_campaign",
  "start_wa_campaign",
  "stop_wa_campaign",
  "delete_contact",
  "delete_group",
  "delete_sms_sent",
  "delete_sms_campaign",
  "delete_wa_account",
  "delete_wa_sent",
  "delete_wa_campaign",
  "delete_sms_received",
  "delete_wa_received",
  "delete_ussd",
  "delete_unsubscribed",
  // "delete_notification" — not supported in this SMS Tools instance
] as const;

export const smsToolsAdmin = {
  async createUser(payload: SmsToolsAdminCreateUserPayload): Promise<{ id: number }> {
    return postForm<{ id: number }>("/create/user", {
      name: payload.name,
      email: payload.email,
      password: payload.password,
      credits: payload.credits ?? 0,
      // SMS Tools expects timezone in lowercase (e.g. "america/lima" not "America/Lima")
      timezone: (payload.timezone ?? "america/lima").toLowerCase(),
      country: payload.country ?? "PE",
      language: payload.language ?? 1,
      theme: payload.theme ?? "light",
      role: payload.role ?? 1,
    });
  },

  async createApiKey(
    userId: number,
    name: string,
    permissions: readonly string[] = DEFAULT_API_KEY_PERMISSIONS,
  ): Promise<SmsToolsAdminApiKey> {
    return postForm<SmsToolsAdminApiKey>("/create/apikey", {
      id: userId,
      name,
      permissions: [...permissions],
    });
  },

  async deleteUser(userId: number): Promise<void> {
    await getJson<unknown>("/delete/user", { id: userId });
  },
};
