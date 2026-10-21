/**
 * Registro de proveedores de IA soportados por tenant.
 *
 * Anthropic y Google Gemini exponen endpoints COMPATIBLES con el formato
 * chat-completions de OpenAI (mismo shape de messages/tools/tool_calls con
 * `Authorization: Bearer`), así que todo el sistema comparte el mismo cliente
 * (lib/openai.ts) cambiando solo la base URL. Las diferencias reales entre
 * proveedores se modelan como capacidades (caps) que los call sites respetan:
 * - jsonSchema: si `response_format: json_schema` es confiable; si no, se pide
 *   "solo JSON" por prompt y se parsea tolerante (parseJsonLoose).
 * - inlineImages: si las imágenes deben inlinearse como data-URI base64 (no
 *   todos descargan URLs públicas).
 * - maxTemperature: Anthropic acepta máximo 1 (OpenAI/Gemini llegan a 2).
 * Además, los modelos Claude 4.7+ (Haiku/Sonnet/Opus 5.5…) tienen reglas propias
 * en esa capa (ver claudeModelCaps): rechazan temperature ≠ 1, algunos rechazan
 * tool_choice forzado y traen el pensamiento activo por defecto. Esas reglas se
 * aplican SOLO cuando la base URL es la de Anthropic y el modelo es 4.7+: para
 * OpenAI, Gemini y los Claude anteriores el cuerpo de la petición no cambia.
 *
 * Nota de columnas: AgentConfig.openaiModel/openaiApiKey guardan el modelo y
 * la key DEL PROVEEDOR ELEGIDO (nombre legado, sin rename de columnas).
 */

import { decryptCredential } from "./credentials-crypto";

export type AiProviderId = "OPENAI" | "ANTHROPIC" | "GOOGLE";

export interface AiProviderInfo {
  id: AiProviderId;
  label: string;
  baseUrl: string;
  models: Array<{ id: string; hint: string }>;
  caps: {
    jsonSchema: boolean;
    inlineImages: boolean;
    maxTemperature: number;
  };
}

export const AI_PROVIDERS: Record<AiProviderId, AiProviderInfo> = {
  OPENAI: {
    id: "OPENAI",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: [
      { id: "gpt-4o-mini", hint: "Rápido y económico" },
      { id: "gpt-4.1-mini", hint: "Buen equilibrio costo/calidad para ventas" },
      { id: "gpt-4.1", hint: "Mayor calidad de razonamiento" },
      { id: "gpt-4o", hint: "Multimodal de alta calidad" },
    ],
    caps: { jsonSchema: true, inlineImages: false, maxTemperature: 2 },
  },
  ANTHROPIC: {
    id: "ANTHROPIC",
    label: "Anthropic (Claude)",
    baseUrl: "https://api.anthropic.com/v1",
    models: [
      { id: "claude-haiku-5-5", hint: "Rápido y económico (recomendado)" },
      { id: "claude-sonnet-5-5", hint: "Alta calidad para ventas" },
      { id: "claude-opus-5-5", hint: "Máxima calidad: más caro y lento" },
    ],
    caps: { jsonSchema: false, inlineImages: true, maxTemperature: 1 },
  },
  GOOGLE: {
    id: "GOOGLE",
    label: "Google (Gemini)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: [
      { id: "gemini-2.5-flash-lite", hint: "Rápido y económico" },
      { id: "gemini-2.5-flash", hint: "Buen equilibrio costo/calidad" },
      { id: "gemini-2.5-pro", hint: "Mayor calidad de razonamiento" },
    ],
    caps: { jsonSchema: true, inlineImages: true, maxTemperature: 2 },
  },
};

/** Particularidades por modelo en la capa OpenAI-compatible de Anthropic. */
export interface ClaudeModelCaps {
  /** false = el modelo devuelve 400 con temperature/top_p distintos del default (Claude 4.7+). */
  sampling: boolean;
  /** false = tool_choice forzado devuelve 400 (Opus 5.5, Sonnet 5.5, Fable, Mythos). */
  forcedToolChoice: boolean;
  /** Cómo apagar el pensamiento (activo por defecto en Claude 5.x); null = no se manda nada. */
  thinkingOff: "disabled" | "between_tools" | null;
}

const NO_MODEL_CHANGES: ClaudeModelCaps = { sampling: true, forcedToolChoice: true, thinkingOff: null };

/** Con el pensamiento activo (no se puede apagar) el thinking consume max_tokens
 *  y la capa compatible no lo devuelve: piso para que no se coma la respuesta. */
export const THINKING_MAX_TOKENS_FLOOR = 8000;

/**
 * Reglas de la capa OpenAI-compatible de Anthropic según el modelo. Para
 * cualquier base URL que no sea la de Anthropic, o para Claude 3.x / 4.0-4.6
 * (aceptan temperature y forzado, y no piensan por defecto), devuelve "sin
 * cambios". Un ID desconocido bajo Anthropic se trata como modelo nuevo.
 */
export function claudeModelCaps(baseUrl: string | null | undefined, model: string): ClaudeModelCaps {
  if (!baseUrl || !baseUrl.includes("api.anthropic.com")) return NO_MODEL_CHANGES;
  const id = (model ?? "").trim().toLowerCase();
  if (/^claude-(2|3)/.test(id) || /^claude-(haiku|sonnet|opus)-4-[0-6](\D|$)/.test(id)) return NO_MODEL_CHANGES;
  const noForced = /^claude-(opus-5-5|sonnet-5-5|fable|mythos)/.test(id);
  const thinkingOff: ClaudeModelCaps["thinkingOff"] = /^claude-sonnet-5-5/.test(id)
    ? "between_tools"
    : /^claude-(opus-5-5|fable|mythos)/.test(id)
      ? null
      : "disabled";
  return { sampling: false, forcedToolChoice: !noForced, thinkingOff };
}

/**
 * Fragmento del cuerpo chat/completions (temperature, max_tokens, thinking)
 * ajustado al modelo. Para OpenAI/Gemini/Claude legacy devuelve exactamente
 * `{ temperature, max_tokens }` como hasta ahora.
 */
export function chatBodyParams(
  baseUrl: string | null | undefined,
  model: string,
  p: { temperature: number; maxTokens: number },
): { temperature?: number; max_tokens: number; thinking?: { type: "disabled" | "between_tools" } } {
  const caps = claudeModelCaps(baseUrl, model);
  const thinkingOn = !caps.sampling && caps.thinkingOff === null;
  return {
    ...(caps.sampling ? { temperature: p.temperature } : {}),
    max_tokens: thinkingOn ? Math.max(p.maxTokens, THINKING_MAX_TOKENS_FLOOR) : p.maxTokens,
    ...(caps.thinkingOff ? { thinking: { type: caps.thinkingOff } } : {}),
  };
}

export function providerOf(id: string | null | undefined): AiProviderInfo {
  return AI_PROVIDERS[(id ?? "OPENAI") as AiProviderId] ?? AI_PROVIDERS.OPENAI;
}

export interface AiSettings {
  provider: AiProviderId;
  baseUrl: string;
  /** Key descifrada del proveedor elegido ("" si no hay). */
  apiKey: string;
  model: string;
  /** Clampeada al máximo del proveedor. */
  temperature: number;
  caps: AiProviderInfo["caps"];
  /** Key para Whisper (audios): la principal si el proveedor es OpenAI; si no,
   *  la key OpenAI opcional dedicada a transcripción ("" si no hay). */
  transcriptionApiKey: string;
}

export function resolveAiSettings(row: {
  aiProvider?: string | null;
  openaiModel?: string | null;
  openaiApiKey?: string | null;
  transcriptionApiKey?: string | null;
  temperature?: unknown;
}): AiSettings {
  const info = providerOf(row.aiProvider);
  const apiKey = decryptCredential(row.openaiApiKey);
  const rawTemp = Number(row.temperature ?? 0.25);
  return {
    provider: info.id,
    baseUrl: info.baseUrl,
    apiKey,
    model: row.openaiModel?.trim() || info.models[0].id,
    temperature: Math.min(Number.isFinite(rawTemp) ? rawTemp : 0.25, info.caps.maxTemperature),
    caps: info.caps,
    transcriptionApiKey: info.id === "OPENAI" ? apiKey : decryptCredential(row.transcriptionApiKey),
  };
}

/** Descarga una imagen y la devuelve como data-URI base64 (null si falla o pesa >8MB). */
export async function imageUrlToDataUri(url: string): Promise<string | null> {
  if (url.startsWith("data:")) return url;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0 || buffer.length > 8 * 1024 * 1024) return null;
    const mime = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim();
    return `data:${mime};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

/** URL lista para el proveedor: OpenAI acepta URLs públicas; el resto la inlinea. */
export async function prepareImageUrl(url: string, caps: { inlineImages: boolean }): Promise<string> {
  if (!caps.inlineImages) return url;
  return (await imageUrlToDataUri(url)) ?? url;
}

/** Parser tolerante para respuestas "solo JSON" sin response_format: quita
 *  fences ```json y recorta al primer {...último}. Null si no hay JSON válido. */
export function parseJsonLoose(raw: string): unknown | null {
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}
