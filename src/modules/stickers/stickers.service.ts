/**
 * Galería de stickers del negocio: subida con conversión a WebP 512×512 (sharp),
 * guardado de stickers recibidos en los chats y listado/borrado. Los archivos
 * viven en uploads/stickers/{companyId}/ y se sirven como el resto de /uploads.
 */
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import sharp from "sharp";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { env } from "../../config/env";

/** Tope del gateway para WebP animado (el estático debe ser ≤100 KB; sharp lo deja muy por debajo). */
const MAX_STICKER_BYTES = 500 * 1024;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export const STICKER_UPLOAD_LIMIT = MAX_UPLOAD_BYTES;

function publicUrl(rel: string) {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/uploads/${rel}`;
}

async function writeSticker(companyId: string, buffer: Buffer): Promise<string> {
  const rel = `stickers/${companyId}/${crypto.randomUUID()}.webp`;
  const abs = path.resolve(process.cwd(), env.UPLOAD_DIR, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buffer);
  return publicUrl(rel);
}

/**
 * Convierte cualquier imagen a WebP 512×512 (fit cover). Un WebP animado se
 * conserva tal cual (recodificarlo perdería la animación); un WebP estático
 * también pasa por el resize para garantizar 512×512.
 */
async function toStickerWebp(input: Buffer): Promise<Buffer> {
  const meta = await sharp(input, { animated: true }).metadata();
  const animated = (meta.pages ?? 1) > 1 && meta.format === "webp";
  if (animated) {
    if (input.length > MAX_STICKER_BYTES) throw new AppError("El WebP animado supera los 500 KB que admite WhatsApp", 422);
    return input;
  }
  const out = await sharp(input).resize(512, 512, { fit: "cover" }).webp({ quality: 90 }).toBuffer();
  if (out.length > MAX_STICKER_BYTES) {
    const smaller = await sharp(input).resize(512, 512, { fit: "cover" }).webp({ quality: 60 }).toBuffer();
    if (smaller.length > MAX_STICKER_BYTES) throw new AppError("No se pudo reducir el sticker a menos de 500 KB", 422);
    return smaller;
  }
  return out;
}

export async function listStickers(companyId: string) {
  return prisma.stickerAsset.findMany({
    where: { companyId },
    orderBy: [{ lastUsedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    select: { id: true, url: true, source: true, lastUsedAt: true, createdAt: true },
  });
}

/** Sube una imagen (cualquier formato) y la deja como sticker WebP en la galería. */
export async function uploadSticker(companyId: string, file: { buffer: Buffer; mimetype: string; size: number }) {
  if (!file.mimetype.startsWith("image/")) throw new AppError("Solo se aceptan imágenes (PNG, JPG o WebP)", 400);
  if (file.size > MAX_UPLOAD_BYTES) throw new AppError("La imagen supera los 5 MB", 413);
  let webp: Buffer;
  try {
    webp = await toStickerWebp(file.buffer);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("No se pudo convertir la imagen a sticker", 422);
  }
  const url = await writeSticker(companyId, webp);
  return prisma.stickerAsset.create({
    data: { companyId, url, source: "UPLOAD" },
    select: { id: true, url: true, source: true, lastUsedAt: true, createdAt: true },
  });
}

/** Guarda en la galería un sticker recibido en un chat (lo copia a /uploads para no depender del gateway). */
export async function saveReceivedSticker(companyId: string, sourceUrl: string) {
  if (!/^https?:\/\//i.test(sourceUrl)) throw new AppError("URL de sticker inválida", 400);
  const existing = await prisma.stickerAsset.findFirst({
    where: { companyId, OR: [{ sourceUrl }, { url: sourceUrl }] },
    select: { id: true, url: true, source: true, lastUsedAt: true, createdAt: true },
  });
  if (existing) return { ...existing, existed: true };
  let buf: Buffer;
  try {
    const res = await fetch(sourceUrl);
    if (!res.ok) throw new Error(String(res.status));
    buf = Buffer.from(await res.arrayBuffer());
  } catch {
    throw new AppError("No se pudo descargar el sticker", 502);
  }
  const meta = await sharp(buf, { animated: true }).metadata().catch(() => null);
  if (!meta || meta.format !== "webp") throw new AppError("Ese adjunto no es un sticker WebP", 422);
  if (buf.length > MAX_STICKER_BYTES) throw new AppError("El sticker supera los 500 KB", 422);
  const url = await writeSticker(companyId, buf);
  const created = await prisma.stickerAsset.create({
    data: { companyId, url, source: "RECEIVED", sourceUrl },
    select: { id: true, url: true, source: true, lastUsedAt: true, createdAt: true },
  });
  return { ...created, existed: false };
}

export async function deleteSticker(companyId: string, id: string) {
  const row = await prisma.stickerAsset.findFirst({ where: { id, companyId }, select: { id: true, url: true } });
  if (!row) throw new AppError("Sticker no encontrado", 404);
  await prisma.stickerAsset.delete({ where: { id: row.id } });
  const base = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/uploads/`;
  if (row.url.startsWith(base)) {
    const rel = row.url.slice(base.length);
    if (rel.startsWith(`stickers/${companyId}/`) && !rel.includes("..")) {
      await fs.unlink(path.resolve(process.cwd(), env.UPLOAD_DIR, rel)).catch(() => undefined);
    }
  }
}

/** Marca un sticker de la galería como usado (orden «recientes primero»). Best-effort. */
export async function touchStickerByUrl(companyId: string, url: string) {
  await prisma.stickerAsset.updateMany({ where: { companyId, url }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
}
