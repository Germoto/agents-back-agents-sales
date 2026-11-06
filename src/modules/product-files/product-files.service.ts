import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { env } from "../../config/env";
import { PRODUCT_FILE_LIMIT_MB, uploadProductFileMiddleware } from "../../middlewares/upload.middleware";
import { DOCUMENT_MIME, MAX_DOCUMENT_BYTES, MAX_DOCUMENT_MB, documentExtOfUpload } from "../../lib/document-types";
import { ensureMetaCompatibleVideo } from "../../lib/video-transcode";

export type UploadedProductFileResponse = {
  type: "IMAGE" | "VIDEO" | "AUDIO" | "PDF" | "OTHER";
  url: string;
  storagePath: string;
  originalName: string;
  extension: string;
  mimeType: string;
  size: number;
};

/**
 * Tipo de ProductFile. PDF conserva su tipo propio (vista previa en iframe);
 * el resto de documentos del catálogo (zip, xlsx, docx, …) son OTHER ("Archivo").
 */
function detectType(mimeType: string, originalName = ""): UploadedProductFileResponse["type"] {
  if (mimeType.startsWith("image/")) return "IMAGE";
  if (mimeType.startsWith("video/")) return "VIDEO";
  if (mimeType.startsWith("audio/")) return "AUDIO";
  if (documentExtOfUpload(originalName, mimeType) === "pdf") return "PDF";
  return "OTHER";
}

function toForwardSlashes(p: string) {
  return p.replace(/\\/g, "/");
}

function buildPublicUrl(storagePathRel: string) {
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  return `${base}/uploads/${storagePathRel}`;
}

function ensureSafeStoragePath(storagePath: string): string {
  // Must start with products/ to avoid arbitrary deletions
  const normalized = toForwardSlashes(storagePath).replace(/^\/+/, "");
  if (!normalized.startsWith("products/")) {
    throw new AppError("Ruta de archivo invalida", 400);
  }
  if (normalized.includes("..")) {
    throw new AppError("Ruta de archivo invalida", 400);
  }
  return normalized;
}

function ensureBelongsToCompany(storagePath: string, companyId: string) {
  const normalized = ensureSafeStoragePath(storagePath);
  if (!normalized.startsWith(`products/${companyId}/`)) {
    throw new AppError("No autorizado para esta ruta", 403);
  }
  return normalized;
}

async function deletePhysicalFile(storagePathRel: string) {
  const absolute = path.resolve(process.cwd(), env.UPLOAD_DIR, storagePathRel);
  try {
    await fs.unlink(absolute);
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      // swallow other errors but log
      // eslint-disable-next-line no-console
      console.warn("[product-files] No se pudo eliminar archivo:", absolute, err?.message);
    }
  }
}

/**
 * Guarda un buffer YA descargado (p.ej. una imagen por URL externa vía el
 * conector MCP) como archivo de producto del tenant, con el mismo shape que
 * devuelve el upload multipart del panel.
 */
export async function saveBufferAsProductFile(
  companyId: string,
  buffer: Buffer,
  mimeType: string,
  originalName: string,
): Promise<UploadedProductFileResponse> {
  const cleanMime = mimeType.split(";")[0].trim().toLowerCase();
  const extByMime: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    ...Object.fromEntries(Object.entries(DOCUMENT_MIME).map(([ext, mime]) => [mime, ext])),
  };
  const extFromName = path.extname(originalName).replace(".", "").toLowerCase();
  const extension = documentExtOfUpload(originalName, cleanMime) ?? extByMime[cleanMime] ?? (extFromName || "bin");
  const rel = `products/${companyId}/${crypto.randomUUID()}.${extension}`;
  const absolute = path.resolve(process.cwd(), env.UPLOAD_DIR, rel);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, buffer);
  return {
    type: detectType(cleanMime, originalName),
    url: buildPublicUrl(rel),
    storagePath: rel,
    originalName: originalName || `imagen.${extension}`,
    extension,
    mimeType: cleanMime,
    size: buffer.length,
  };
}

export const uploadProductFileMiddlewareExport = uploadProductFileMiddleware;

export async function uploadHandler(req: Request, res: Response) {
  const companyId = req.user!.companyId;
  const file = req.file;
  if (!file) {
    throw new AppError("Archivo no recibido", 400);
  }
  return res.status(201).json(await finalizeUploadedFile(companyId, file));
}

/**
 * Núcleo de la subida (panel y enlace de subida): valida la ruta y el tope por tipo,
 * fija el MIME canónico de documentos y normaliza video. Devuelve el shape de ProductFile.
 */
export async function finalizeUploadedFile(companyId: string, file: Express.Multer.File): Promise<UploadedProductFileResponse> {
  let storagePathAbs = file.path;
  const baseDir = path.resolve(process.cwd(), env.UPLOAD_DIR);
  let relativePath = toForwardSlashes(path.relative(baseDir, storagePathAbs));

  // safety: ensure path is inside expected dir
  if (!relativePath.startsWith(`products/${companyId}/`)) {
    await fs.unlink(storagePathAbs).catch(() => undefined);
    throw new AppError("Ruta de almacenamiento invalida", 500);
  }

  const type = detectType(file.mimetype, file.originalname);
  const docExt = documentExtOfUpload(file.originalname, file.mimetype);

  // Tope por tipo: documentos hasta MAX_DOCUMENT_MB; imagen/video/audio hasta MAX_UPLOAD_MB
  // (multer solo aplicó el mayor de los dos).
  const limitBytes = docExt ? MAX_DOCUMENT_BYTES : env.MAX_UPLOAD_MB * 1024 * 1024;
  if (file.size > limitBytes) {
    await fs.unlink(storagePathAbs).catch(() => undefined);
    throw new AppError(`Archivo demasiado grande (max ${docExt ? MAX_DOCUMENT_MB : env.MAX_UPLOAD_MB}MB)`, 413);
  }

  let ext = path.extname(file.originalname).replace(/^\./, "").toLowerCase() || path.extname(file.filename).replace(/^\./, "").toLowerCase();
  // MIME canónico para documentos (el navegador manda octet-stream para zip/rar/7z).
  let mimeType = docExt ? DOCUMENT_MIME[docExt] : file.mimetype;
  let size = file.size;
  if (docExt) ext = docExt;

  // Normalizar video a H.264/AAC mp4 (compatible con la API oficial de Meta).
  // Cubre TODOS los módulos: todos suben por este único endpoint. Best-effort:
  // si la conversión falla, se conserva el archivo original.
  if (type === "VIDEO") {
    const result = await ensureMetaCompatibleVideo(storagePathAbs);
    if (result.changed) {
      storagePathAbs = result.path;
      relativePath = toForwardSlashes(path.relative(baseDir, storagePathAbs));
      ext = "mp4";
      mimeType = "video/mp4";
      size = (await fs.stat(storagePathAbs)).size;
    }
  }

  return {
    type,
    url: buildPublicUrl(relativePath),
    storagePath: relativePath,
    originalName: file.originalname,
    extension: ext,
    mimeType,
    size,
  };
}

export async function deletePersistedHandler(req: Request, res: Response) {
  const companyId = req.user!.companyId;
  const id = String(req.params.id);

  const file = await prisma.productFile.findUnique({
    where: { id },
    include: { product: true },
  });

  if (!file || file.product.companyId !== companyId) {
    throw new AppError("Archivo no encontrado", 404);
  }

  if (file.storagePath) {
    const safe = ensureBelongsToCompany(file.storagePath, companyId);
    await deletePhysicalFile(safe);
  }

  await prisma.productFile.delete({ where: { id } });

  return res.json({ success: true });
}

export async function deleteOrphanHandler(req: Request, res: Response) {
  const companyId = req.user!.companyId;
  const storagePath = req.body?.storagePath;

  if (typeof storagePath !== "string" || !storagePath.length) {
    throw new AppError("storagePath requerido", 400);
  }

  const safe = ensureBelongsToCompany(storagePath, companyId);
  await deletePhysicalFile(safe);

  return res.json({ success: true });
}

export function uploadErrorTrap(err: any, _req: Request, _res: Response, next: NextFunction) {
  if (!err) return next();
  // Translate multer/file errors to AppError
  if (err.code === "LIMIT_FILE_SIZE") {
    return next(new AppError(`Archivo demasiado grande (max ${PRODUCT_FILE_LIMIT_MB}MB)`, 413));
  }
  return next(err);
}
