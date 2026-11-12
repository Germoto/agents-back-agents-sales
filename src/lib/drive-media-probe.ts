/**
 * Formato REAL de un video/audio de Drive antes de adjuntarlo por WhatsApp.
 * La extensión no basta: un .mp4 puede ser un MOV de iPhone con HEVC (H.265),
 * que llega pero muchos celulares no lo reproducen ("no carga"). Se leen los
 * bytes (el adjunto ya está topado en 16 MB) y se revisa contenedor y códec.
 * Sin BD: caché en memoria por archivo. Sin dependencias (ni env): se puede probar suelto.
 */

export type MediaProbe =
  | { ok: true }
  | { ok: false; motivo: string }
  /** No se pudo leer (Drive no respondió, archivo raro): no se bloquea el adjunto. */
  | { ok: null };

const PROBE_TIMEOUT_MS = 20_000;
const PROBE_MAX_BYTES = 17 * 1024 * 1024;
const CACHE_MAX = 500;
const cache = new Map<string, MediaProbe>();
const inFlight = new Map<string, Promise<MediaProbe>>();

/** Extensiones con contenedor ISO (mp4/3gp/m4a): las únicas que se inspeccionan. */
const ISO_EXTS = ["mp4", "m4v", "3gp", "m4a"];
const VIDEO_OK = ["avc1", "avc3", "mp4v", "s263", "h263"];
const AUDIO_OK = ["mp4a", "samr", "sawb"];
const CODEC_LABEL: Record<string, string> = {
  hvc1: "HEVC (H.265)",
  hev1: "HEVC (H.265)",
  dvh1: "Dolby Vision",
  dvhe: "Dolby Vision",
  av01: "AV1",
  vp09: "VP9",
  apch: "ProRes",
  apcn: "ProRes",
  alac: "ALAC",
};

export function needsMediaProbe(name: string): boolean {
  const ext = (name.match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? "").toLowerCase();
  return ISO_EXTS.includes(ext);
}

interface Atom {
  type: string;
  start: number;
  end: number;
}

function atomsIn(buf: Buffer, from: number, to: number): Atom[] {
  const out: Atom[] = [];
  let i = from;
  while (i + 8 <= to) {
    let size = buf.readUInt32BE(i);
    const type = buf.toString("latin1", i + 4, i + 8);
    let header = 8;
    if (size === 1) {
      if (i + 16 > to) break;
      size = Number(buf.readBigUInt64BE(i + 8));
      header = 16;
    } else if (size === 0) size = to - i;
    if (size < header || i + size > to) break;
    out.push({ type, start: i + header, end: i + size });
    i += size;
  }
  return out;
}

function child(buf: Buffer, parent: Atom, type: string): Atom | undefined {
  return atomsIn(buf, parent.start, parent.end).find((a) => a.type === type);
}

/** Pistas de video/audio con su códec (fourcc del primer sample entry). */
function tracksOf(buf: Buffer, moov: Atom): Array<{ handler: string; codec: string }> {
  const out: Array<{ handler: string; codec: string }> = [];
  for (const trak of atomsIn(buf, moov.start, moov.end).filter((a) => a.type === "trak")) {
    const mdia = child(buf, trak, "mdia");
    const hdlr = mdia && child(buf, mdia, "hdlr");
    const minf = mdia && child(buf, mdia, "minf");
    const stbl = minf && child(buf, minf, "stbl");
    const stsd = stbl && child(buf, stbl, "stsd");
    if (!hdlr || !stsd || hdlr.start + 12 > hdlr.end || stsd.start + 16 > stsd.end) continue;
    out.push({
      handler: buf.toString("latin1", hdlr.start + 8, hdlr.start + 12),
      codec: buf.toString("latin1", stsd.start + 12, stsd.start + 16),
    });
  }
  return out;
}

/** Función pura: ¿WhatsApp reproduce este mp4/3gp/m4a en cualquier celular? */
export function inspectIsoMedia(buf: Buffer): MediaProbe {
  if (buf.length < 16) return { ok: null };
  const top = atomsIn(buf, 0, buf.length);
  const ftyp = top.find((a) => a.type === "ftyp");
  if (!ftyp) {
    // Sin cabecera ISO: es otro contenedor (mkv, webm, avi…) con extensión cambiada.
    return top.length ? { ok: null } : { ok: false, motivo: "no es un MP4 real (otro contenedor con extensión cambiada)" };
  }
  const brand = buf.toString("latin1", ftyp.start, ftyp.start + 4);
  const moov = top.find((a) => a.type === "moov");
  const tracks = moov ? tracksOf(buf, moov) : [];
  const badVideo = tracks.find((t) => t.handler === "vide" && !VIDEO_OK.includes(t.codec));
  if (badVideo) return { ok: false, motivo: `video en ${CODEC_LABEL[badVideo.codec] ?? badVideo.codec.trim()}: muchos celulares no lo reproducen` };
  const badAudio = tracks.find((t) => t.handler === "soun" && !AUDIO_OK.includes(t.codec));
  if (badAudio) return { ok: false, motivo: `audio en ${CODEC_LABEL[badAudio.codec] ?? badAudio.codec.trim()}: muchos celulares no lo reproducen` };
  if (brand === "qt  ") return { ok: false, motivo: "es un MOV (QuickTime) con extensión cambiada" };
  if (!moov) return { ok: null };
  return { ok: true };
}

async function download(fileId: string): Promise<Buffer | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`, { signal: ctrl.signal });
    if (!res.ok) return null;
    // Página HTML (aviso de Drive, archivo ya no público): no son los bytes.
    if ((res.headers.get("content-type") ?? "").includes("text/html")) return null;
    if (Number(res.headers.get("content-length") ?? 0) > PROBE_MAX_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > PROBE_MAX_BYTES ? null : buf;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Revisa el formato real de un archivo de Drive (una sola descarga por archivo; se recuerda el resultado). */
export async function probeDriveMedia(fileId: string): Promise<MediaProbe> {
  const cached = cache.get(fileId);
  if (cached) return cached;
  const running = inFlight.get(fileId);
  if (running) return running;
  const job = (async (): Promise<MediaProbe> => {
    const buf = await download(fileId);
    const result: MediaProbe = buf ? inspectIsoMedia(buf) : { ok: null };
    // Lo no leído no se recuerda: se reintenta la próxima vez.
    if (result.ok !== null) {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
      cache.set(fileId, result);
    }
    return result;
  })();
  inFlight.set(fileId, job);
  try {
    return await job;
  } finally {
    inFlight.delete(fileId);
  }
}
