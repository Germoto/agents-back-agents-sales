/**
 * Transcripción de notas de voz entrantes (WhatsApp) con la API de OpenAI del
 * tenant. Best-effort como receipt-vision: devuelve la transcripción o null,
 * NUNCA lanza — si falla, el turno sigue y el historial usa el placeholder de
 * audio no transcrito.
 */

// Modelo principal + fallback universal (algunas keys no tienen acceso al nuevo).
const TRANSCRIBE_MODELS = ["gpt-4o-mini-transcribe", "whisper-1"] as const;

/** Extensión razonable para el filename del multipart (OpenAI la usa para el formato). */
function fileNameFor(contentType: string, url: string): string {
  const ct = contentType.split(";")[0].trim().toLowerCase();
  const byCt: Record<string, string> = {
    "audio/ogg": "audio.ogg",
    "audio/mpeg": "audio.mp3",
    "audio/mp4": "audio.m4a",
    "audio/aac": "audio.aac",
    "audio/wav": "audio.wav",
    "audio/webm": "audio.webm",
  };
  if (byCt[ct]) return byCt[ct];
  const m = url.match(/\.([a-z0-9]{2,5})(?:\?|$)/i);
  return m ? `audio.${m[1].toLowerCase()}` : "audio.ogg";
}

export async function transcribeAudio(
  apiKey: string | null | undefined,
  audioUrl: string,
): Promise<string | null> {
  if (!apiKey) return null;
  try {
    // La mediaUrl ya es nuestra (uploads/inbound persistido): descarga directa.
    const audioRes = await fetch(audioUrl);
    if (!audioRes.ok) {
      console.warn(`[transcribe] no se pudo descargar el audio (HTTP ${audioRes.status})`);
      return null;
    }
    const buffer = Buffer.from(await audioRes.arrayBuffer());
    if (buffer.length === 0) return null;
    const contentType = (audioRes.headers.get("content-type") ?? "audio/ogg").split(";")[0].trim();
    const filename = fileNameFor(contentType, audioUrl);

    for (const model of TRANSCRIBE_MODELS) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(buffer)], { type: contentType }), filename);
      form.append("model", model);

      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` }, // sin Content-Type: FormData pone el boundary
        body: form,
      });
      if (!res.ok) {
        console.warn(`[transcribe] OpenAI ${res.status} con ${model}${model === "whisper-1" ? "" : ", probando fallback"}`);
        continue;
      }
      const data = (await res.json()) as { text?: string };
      const text = (data.text ?? "").trim();
      return text || null;
    }
    return null;
  } catch (err) {
    console.warn("[transcribe] falló:", err instanceof Error ? err.message : err);
    return null;
  }
}
