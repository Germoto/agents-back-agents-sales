/**
 * Descarga la media entrante (comprobantes, fotos del cliente) a /uploads y
 * devuelve una URL pública propia. Las URLs que entrega SMS Tools en el inbound
 * son temporales y/o no renderizan en el navegador (fallan en <img>), así que
 * para poder mostrarlas en el panel (chat + lupa de comprobantes) y conservarlas
 * las copiamos a nuestro almacenamiento estático.
 */

import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { env } from "../config/env";

const EXT_BY_TYPE: Record<string, string> = {
  image: "jpg",
  video: "mp4",
  audio: "ogg",
  document: "pdf",
};

function extFromContentType(ct: string): string | null {
  const t = ct.split(";")[0].trim().toLowerCase();
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "application/pdf": "pdf",
  };
  return map[t] ?? null;
}

function extFromUrl(url: string): string | null {
  try {
    const p = new URL(url).pathname;
    const m = p.match(/\.([a-z0-9]{2,5})$/i);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Descarga `url` y la guarda en /uploads/inbound/<companyId>/<uuid>.<ext>.
 * Devuelve la URL pública o `null` si falla (el caller cae a la URL original).
 */
export async function persistInboundMedia(
  companyId: string,
  url: string,
  type: string,
  headers?: Record<string, string>,
): Promise<string | null> {
  try {
    // Ya es una URL nuestra (p.ej. el webhook de Meta la persistió antes de
    // llamar a handleInbound): no re-descargarse a sí mismo.
    const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
    if (url.startsWith(`${base}/uploads/`)) return url;

    const res = await fetch(url, headers ? { headers } : undefined);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return null;

    const ext =
      extFromContentType(res.headers.get("content-type") ?? "") ??
      extFromUrl(url) ??
      EXT_BY_TYPE[type] ??
      "bin";

    const dir = path.resolve(process.cwd(), env.UPLOAD_DIR, "inbound", companyId);
    await fs.mkdir(dir, { recursive: true });
    const name = `${crypto.randomUUID()}.${ext}`;
    await fs.writeFile(path.join(dir, name), buf);

    return `${base}/uploads/inbound/${companyId}/${name}`;
  } catch (err) {
    console.error("[inbound-media] no se pudo descargar la media entrante:", err instanceof Error ? err.message : err);
    return null;
  }
}
