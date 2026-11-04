/**
 * "Ojos" para los stickers entrantes: UNA llamada de visión que describe qué
 * muestra o expresa el sticker (personaje, emoción, texto) para que el agente
 * (texto-only) responda en contexto. Sin lógica de comprobante, sin aviso al
 * admin y sin depender de que los pagos estén activos. Best-effort: null si falla.
 *
 * Los stickers llegan como WebP (estático o animado). Para que ningún proveedor
 * lo rechace, se convierte a un PNG fijo (primer fotograma) con sharp y se manda
 * inline como data-URI.
 */

import sharp from "sharp";
import { chatBodyParams } from "../../lib/ai-providers";
import { postChatCompletions } from "../../lib/openai";

const MAX_BYTES = 8 * 1024 * 1024;

const SYSTEM =
  "Eres un analista de imágenes para un chat de ventas por WhatsApp (Perú). El cliente envió un STICKER. " +
  "Describe en UNA frase corta y neutral en español qué muestra o expresa: personaje o figura, gesto o emoción " +
  "(risa, enojo, tristeza, saludo, aprobación, burla, etc.) y el texto que contenga, si lo hay. " +
  "Responde solo con la frase, sin comillas ni explicaciones. Ej.: 'un gato con pulgar arriba y el texto OK', " +
  "'un personaje llorando de risa', 'un emoji de corazón'.";

/** Descarga el sticker y lo convierte a PNG fijo (primer fotograma si es animado). */
async function stickerToPngDataUri(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0 || buffer.length > MAX_BYTES) return null;
    // sharp sin `animated: true` lee solo el primer fotograma de un WebP animado.
    const png = await sharp(buffer).png().toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch (err) {
    console.warn("[sticker-vision] no se pudo preparar el sticker:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Devuelve la descripción del sticker con el proveedor de IA del tenant, o null. */
export async function describeSticker(
  ai: { apiKey: string; model: string; baseUrl?: string },
  stickerUrl: string,
): Promise<string | null> {
  try {
    if (!/^(https?:\/\/|data:)/i.test(stickerUrl)) return null;
    const dataUri = stickerUrl.startsWith("data:") ? stickerUrl : await stickerToPngDataUri(stickerUrl);
    if (!dataUri) return null;
    const response = await postChatCompletions(ai.baseUrl, ai.apiKey, {
      model: ai.model,
      ...chatBodyParams(ai.baseUrl, ai.model, { temperature: 0, maxTokens: 80 }),
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: [
            { type: "text", text: "Describe este sticker en una frase." },
            { type: "image_url", image_url: { url: dataUri } },
          ],
        },
      ],
    });
    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.text()).replace(/\s+/g, " ").slice(0, 200);
      } catch {
        // ignore
      }
      console.warn(`[sticker-vision] proveedor IA ${response.status}${detail ? `: ${detail}` : ""}`);
      return null;
    }
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
    const raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw) return null;
    // Una sola línea, sin comillas envolventes ni punto final.
    const line = raw.split(/\r?\n/)[0].replace(/^["'“”]+|["'“”.]+$/g, "").trim();
    return line ? line.slice(0, 200) : null;
  } catch (err) {
    console.warn("[sticker-vision] fallo:", err instanceof Error ? err.message : err);
    return null;
  }
}
