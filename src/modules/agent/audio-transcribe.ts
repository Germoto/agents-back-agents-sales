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

const ATTEMPTS = 2;
const RETRY_DELAY_MS = 1500;

/** Un intento: texto, "" si OpenAI devolvió vacío, o null si falló (con el motivo en el log). */
async function attemptTranscription(apiKey: string, audioUrl: string, attempt: number): Promise<string | null> {
  // La mediaUrl ya es nuestra (uploads/inbound persistido): descarga directa.
  const audioRes = await fetch(audioUrl);
  if (!audioRes.ok) {
    console.warn(`[transcribe] intento ${attempt}: no se pudo descargar el audio (HTTP ${audioRes.status})`);
    return null;
  }
  const buffer = Buffer.from(await audioRes.arrayBuffer());
  if (buffer.length === 0) {
    console.warn(`[transcribe] intento ${attempt}: el audio descargado está vacío`);
    return null;
  }
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
      console.warn(`[transcribe] intento ${attempt}: OpenAI ${res.status} con ${model}${model === "whisper-1" ? "" : ", probando fallback"}`);
      continue;
    }
    const data = (await res.json()) as { text?: string };
    return (data.text ?? "").trim();
  }
  return null;
}

export async function transcribeAudio(
  apiKey: string | null | undefined,
  audioUrl: string,
): Promise<string | null> {
  if (!apiKey) return null;
  // Un reintento ante fallas puntuales (descarga, red, OpenAI momentáneo).
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const text = await attemptTranscription(apiKey, audioUrl, attempt);
      if (text !== null) return text || null; // "" = audio sin voz: no se reintenta
    } catch (err) {
      console.warn(`[transcribe] intento ${attempt} falló:`, err instanceof Error ? err.message : err);
    }
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
  return null;
}
