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
      { id: "claude-haiku-4-5", hint: "Rápido y económico" },
      { id: "claude-sonnet-4-5", hint: "Alta calidad para ventas" },
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
