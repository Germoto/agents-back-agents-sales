/**
 * Normaliza videos subidos al formato que la API oficial de Meta entrega:
 * mp4 con video H.264 (yuv420p) + audio AAC. Muchos videos (iPhone/editados)
 * vienen en H.265/HEVC y Meta los rechaza en la entrega ("Media upload error"),
 * aunque sean pequeños. Convertir UNA vez al subir evita recodificar en cada envío.
 *
 * Usa los binarios ffmpeg/ffprobe del sistema (instalados en el Dockerfile) vía
 * child_process — sin dependencias npm, para no tocar package-lock/npm ci.
 * Best-effort: si algo falla, se conserva el archivo original.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";

const execFileAsync = promisify(execFile);

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const TRANSCODE_TIMEOUT_MS = 180_000; // 3 min

/** Devuelve el codec_name del primer stream del tipo pedido, o null. */
async function probeCodec(input: string, kind: "v" | "a"): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      FFPROBE,
      ["-v", "error", "-select_streams", `${kind}:0`, "-show_entries", "stream=codec_name", "-of", "csv=p=0", input],
      { timeout: 30_000 },
    );
    const codec = stdout.trim().toLowerCase();
    return codec || null;
  } catch {
    return null; // sin ese stream (p.ej. video sin audio) o ffprobe no disponible
  }
}

export type TranscodeResult = { path: string; mimeType: string; changed: boolean };

/**
 * Si el video ya es H.264 + (AAC o sin audio) → lo deja tal cual. Si no,
 * transcodifica a mp4 H.264/AAC (máx 1280px de ancho, faststart) y devuelve la
 * nueva ruta. Ante cualquier error, devuelve el original sin cambios.
 */
export async function ensureMetaCompatibleVideo(absPath: string): Promise<TranscodeResult> {
  const original: TranscodeResult = { path: absPath, mimeType: "video/mp4", changed: false };

  const videoCodec = await probeCodec(absPath, "v");
  if (videoCodec === null) {
    // No se pudo analizar (ffprobe ausente/archivo raro): no arriesgar, dejar original.
    return original;
  }
  const audioCodec = await probeCodec(absPath, "a"); // null = sin audio
  const compatible = videoCodec === "h264" && (audioCodec === null || audioCodec === "aac");
  if (compatible) return original;

  const dir = path.dirname(absPath);
  const base = path.basename(absPath, path.extname(absPath));
  const tmpOut = path.join(dir, `${base}.transcoding.mp4`);
  const finalOut = path.join(dir, `${base}.mp4`);

  try {
    await execFileAsync(
      FFMPEG,
      [
        "-y",
        "-i", absPath,
        "-c:v", "libx264",
        "-profile:v", "main",
        "-pix_fmt", "yuv420p",
        "-vf", "scale='min(1280,iw)':-2",
        "-preset", "veryfast",
        "-crf", "28",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        "-max_muxing_queue_size", "1024",
        tmpOut,
      ],
      { timeout: TRANSCODE_TIMEOUT_MS },
    );

    // Reemplazar: el resultado final queda como <base>.mp4
    await fs.rename(tmpOut, finalOut);
    // Si el original tenía otra extensión (.mov, .3gp, ...), borrarlo.
    if (path.resolve(finalOut) !== path.resolve(absPath)) {
      await fs.unlink(absPath).catch(() => undefined);
    }
    return { path: finalOut, mimeType: "video/mp4", changed: true };
  } catch (err) {
    console.error("[video-transcode] falló la conversión, se conserva el original:", err instanceof Error ? err.message : err);
    await fs.unlink(tmpOut).catch(() => undefined);
    return original;
  }
}
