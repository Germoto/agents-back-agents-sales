/**
 * Notas de voz del agente: texto → voz (ElevenLabs, con la clave del negocio) → OGG/Opus
 * mono, que es el único formato que WhatsApp muestra como nota de voz.
 *
 * Usa ffmpeg/ffprobe del sistema (Dockerfile), igual que lib/video-transcode.ts.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { zonedParts, zonedTimeToUtc } from "../scheduler/quiet-hours";
import { VOICE_LIMITS, VOICE_MODELS, VOICE_SOURCE, voiceModelHasTags, type VoiceModel } from "./voice-limits";

export { VOICE_LIMITS, VOICE_MODELS, voiceModelHasTags, type VoiceModel };

const execFileAsync = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

const ELEVEN_BASE = "https://api.elevenlabs.io/v1";
const TTS_TIMEOUT_MS = 45_000;

export type VoiceSettings = {
  voiceId: string;
  model: VoiceModel;
  speed: number;
  stability: number;
  similarity: number;
  /** Expresividad (0 = neutra). Opcional: las configuraciones anteriores no la traen. */
  style?: number;
};

/** Error con mensaje para el dueño (clave inválida, sin saldo…). Nunca se le muestra al cliente. */
export class VoiceError extends Error {}

// ---------------------------------------------------------------------------
// Texto para ser dicho (reglas puras)
// ---------------------------------------------------------------------------

const LINK_RE = /(https?:\/\/|www\.)\S+|\b[\w-]+\.(com|pe|net|org|io|app|co|mx|cl|ar|es|me|link|ly)\b(\/\S*)?/i;

/**
 * Quita lo que no se pronuncia: formato de WhatsApp, emojis, viñetas y saltos de línea.
 * Las marcas entre corchetes ([laughs]) solo se conservan si el modelo las interpreta.
 */
export function cleanSpokenText(raw: string, opts: { keepTags?: boolean } = {}): string {
  return (raw ?? "")
    .replace(/\[[^\]\n]{0,40}\]/g, (tag) => (opts.keepTags ? tag : " "))
    .replace(/[*_~`]/g, "")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .replace(/^\s*(?:[-•▪▢]|\d+[.)])\s+/gm, "")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    // Al quitar un emoji puede quedar un espacio antes de la puntuación.
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

/** Motivo por el que un texto no puede ir en una nota de voz, o null si puede. */
export function voiceTextProblem(text: string, maxChars: number): string | null {
  if (!text) return "El texto de la nota de voz está vacío.";
  if (LINK_RE.test(text)) return "Una nota de voz no puede llevar links ni direcciones web: eso va en el mensaje de texto.";
  if (text.length > maxChars) return `La nota de voz admite hasta ${maxChars} caracteres (llegaron ${text.length}). Acórtala o responde por texto.`;
  return null;
}

// ---------------------------------------------------------------------------
// ElevenLabs
// ---------------------------------------------------------------------------

async function elevenFetch(apiKey: string, pathName: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${ELEVEN_BASE}${pathName}`, {
      ...init,
      headers: { "xi-api-key": apiKey, ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    });
  } catch (err) {
    throw new VoiceError(`No se pudo conectar con ElevenLabs (${err instanceof Error ? err.message : "sin respuesta"}).`);
  }
  if (res.ok) return res;
  const detail = (await res.text().catch(() => "")).slice(0, 300);
  if (res.status === 401) throw new VoiceError("La clave de ElevenLabs no es válida o fue revocada.");
  if (res.status === 402 || /quota|credit/i.test(detail)) throw new VoiceError("La cuenta de ElevenLabs se quedó sin créditos.");
  if (res.status === 404 || /voice_not_found/i.test(detail)) throw new VoiceError("La voz elegida ya no existe en la cuenta de ElevenLabs.");
  if (res.status === 429) throw new VoiceError("ElevenLabs rechazó por exceso de solicitudes. Intenta en un momento.");
  throw new VoiceError(`ElevenLabs devolvió ${res.status}${detail ? `: ${detail}` : ""}`);
}

export type VoiceOption = { id: string; name: string; category: string | null; previewUrl: string | null };

/** Voces de la cuenta del negocio (las clonadas salen con category "cloned"). */
export async function listVoices(apiKey: string): Promise<VoiceOption[]> {
  const res = await elevenFetch(apiKey, "/voices");
  const body = (await res.json()) as { voices?: Array<{ voice_id?: string; name?: string; category?: string; preview_url?: string }> };
  return (body.voices ?? [])
    .filter((v) => v.voice_id && v.name)
    .map((v) => ({ id: v.voice_id!, name: v.name!, category: v.category ?? null, previewUrl: v.preview_url ?? null }))
    // Primero las voces propias (clonadas o creadas), luego las de catálogo.
    .sort((a, b) => Number(a.category === "premade") - Number(b.category === "premade") || a.name.localeCompare(b.name));
}

/** Ajustes completos que se le envían a ElevenLabs. */
export function elevenVoiceSettings(settings: VoiceSettings): Record<string, number | boolean> {
  return {
    stability: settings.stability,
    similarity_boost: settings.similarity,
    style: settings.style ?? VOICE_LIMITS.style.def,
    use_speaker_boost: true,
    speed: settings.speed,
  };
}

/**
 * Ajustes mínimos para los modelos expresivos (v4/v3) cuando rechazan los completos:
 * solo estabilidad, llevada a uno de los tres puntos que esos modelos admiten seguro.
 */
export function elevenFallbackSettings(settings: VoiceSettings): Record<string, number> {
  return { stability: settings.stability < 0.25 ? 0 : settings.stability > 0.75 ? 1 : 0.5 };
}

/** Texto → MP3 con la voz y ajustes del negocio. */
export async function synthesize(apiKey: string, settings: VoiceSettings, text: string): Promise<Buffer> {
  const call = (voiceSettings: Record<string, number | boolean>) =>
    elevenFetch(apiKey, `/text-to-speech/${encodeURIComponent(settings.voiceId)}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: settings.model, voice_settings: voiceSettings }),
    });
  let res: Response;
  try {
    res = await call(elevenVoiceSettings(settings));
  } catch (err) {
    // Los modelos expresivos pueden no aceptar todos los ajustes: un reintento con lo mínimo.
    const rejected = err instanceof VoiceError && /devolvió (400|422)/.test(err.message);
    if (!rejected || !voiceModelHasTags(settings.model)) throw err;
    res = await call(elevenFallbackSettings(settings));
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 200) throw new VoiceError("ElevenLabs no devolvió audio.");
  return buffer;
}

// ---------------------------------------------------------------------------
// Conversión a nota de voz
// ---------------------------------------------------------------------------

/** Duración en segundos de un audio (0 si no se pudo medir). */
export async function audioSeconds(absPath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      FFPROBE,
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", absPath],
      { timeout: 30_000 },
    );
    const n = Number(stdout.trim());
    return Number.isFinite(n) && n > 0 ? Math.max(1, Math.round(n)) : 0;
  } catch {
    return 0;
  }
}

/** Convierte un audio a OGG/Opus mono 32 kbps (el comando que indicó SMS Tools). */
export async function toOggOpus(input: string, output: string): Promise<void> {
  try {
    await execFileAsync(FFMPEG, ["-y", "-i", input, "-vn", "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k", output], {
      timeout: 60_000,
    });
  } catch (err) {
    throw new VoiceError(`No se pudo convertir el audio a nota de voz (${err instanceof Error ? err.message.slice(0, 160) : "ffmpeg"}).`);
  }
}

export type VoiceNote = { url: string; seconds: number };

/** Guarda el MP3 generado como nota de voz en /uploads/voice/<companyId>/ y devuelve su URL. */
export async function saveVoiceNote(companyId: string, mp3: Buffer): Promise<VoiceNote> {
  const dir = path.resolve(process.cwd(), env.UPLOAD_DIR, "voice", companyId);
  await fs.mkdir(dir, { recursive: true });
  const id = crypto.randomUUID();
  const tmp = path.join(dir, `${id}.src.mp3`);
  const out = path.join(dir, `${id}.ogg`);
  await fs.writeFile(tmp, mp3);
  try {
    await toOggOpus(tmp, out);
  } finally {
    await fs.unlink(tmp).catch(() => undefined);
  }
  const seconds = await audioSeconds(out);
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  return { url: `${base}/uploads/voice/${companyId}/${id}.ogg`, seconds };
}

/** Texto → nota de voz lista para enviar. */
export async function generateVoiceNote(companyId: string, apiKey: string, settings: VoiceSettings, text: string): Promise<VoiceNote> {
  return saveVoiceNote(companyId, await synthesize(apiKey, settings, text));
}

// ---------------------------------------------------------------------------
// Tope del día
// ---------------------------------------------------------------------------

/** Notas de voz generadas hoy (día del negocio). Cuenta mensajes ya enviados, sin tabla aparte. */
export async function voiceNotesToday(companyId: string, tz: string | null, now = new Date()): Promise<number> {
  let since: Date;
  try {
    const zone = tz || "America/Lima";
    const p = zonedParts(now, zone);
    since = zonedTimeToUtc(p.year, p.month, p.day, 0, zone);
  } catch {
    since = new Date(now.getTime() - 24 * 60 * 60_000);
  }
  return prisma.conversationMessage.count({
    where: { companyId, role: "ASSISTANT", mediaType: "audio", createdAt: { gte: since }, rawPayload: { path: ["source"], equals: VOICE_SOURCE } },
  });
}
