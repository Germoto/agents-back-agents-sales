/**
 * Generación de imágenes con IA (gpt-image-2 de OpenAI) para el copiloto/MCP:
 * banners de oferta, fotos de producto y creativos que luego se adjuntan a las
 * configuraciones (presentación, recordatorios, respuestas rápidas, campañas).
 *
 * La key es SIEMPRE la de OpenAI del tenant (resolveAiSettings.transcriptionApiKey:
 * la principal si su proveedor es OpenAI, o la key dedicada a audio/imágenes si
 * usa Anthropic/Gemini). Cada negocio paga sus propias imágenes.
 */

import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { env } from "../config/env";

export type ImageGenSize = "1024x1024" | "1536x1024" | "1024x1536";
export type ImageGenQuality = "medium" | "high";

/** Llama a la API de imágenes de OpenAI y devuelve el PNG generado. */
export async function generateImage(opts: {
  apiKey: string;
  prompt: string;
  size: ImageGenSize;
  quality: ImageGenQuality;
}): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.IMAGE_GEN_MODEL,
        prompt: opts.prompt,
        size: opts.size,
        quality: opts.quality,
        n: 1,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new Error(aborted ? "La generación tardó demasiado (timeout de 120s); intenta de nuevo" : "No se pudo contactar la API de imágenes de OpenAI");
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      detail = body?.error?.message ?? "";
    } catch {
      /* cuerpo no-JSON */
    }
    if (res.status === 401) throw new Error("La key de OpenAI no es válida o fue revocada (revisa el panel, Agente IA)");
    if (res.status === 429) throw new Error("OpenAI rechazó por límite de uso o saldo insuficiente en la cuenta del negocio");
    throw new Error(`OpenAI devolvió ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }

  const body = (await res.json()) as { data?: Array<{ b64_json?: string }> };
  const b64 = body.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI no devolvió la imagen (respuesta sin b64_json)");
  return Buffer.from(b64, "base64");
}

/** Guarda la imagen generada en /uploads/generated/<companyId>/ y devuelve su URL pública. */
export async function saveGeneratedImage(companyId: string, buffer: Buffer): Promise<{ url: string; storagePath: string; size: number }> {
  const dir = path.resolve(process.cwd(), env.UPLOAD_DIR, "generated", companyId);
  await fs.mkdir(dir, { recursive: true });
  const name = `${crypto.randomUUID()}.png`;
  await fs.writeFile(path.join(dir, name), buffer);
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const storagePath = `generated/${companyId}/${name}`;
  return { url: `${base}/uploads/${storagePath}`, storagePath, size: buffer.length };
}
