import fs from "fs/promises";
import path from "path";
import { Request, Response, NextFunction } from "express";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { env } from "../../config/env";
import { uploadProductFileMiddleware } from "../../middlewares/upload.middleware";
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

function detectType(mimeType: string): UploadedProductFileResponse["type"] {
  if (mimeType.startsWith("image/")) return "IMAGE";
  if (mimeType.startsWith("video/")) return "VIDEO";
  if (mimeType.startsWith("audio/")) return "AUDIO";
  if (mimeType === "application/pdf") return "PDF";
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

export const uploadProductFileMiddlewareExport = uploadProductFileMiddleware;

export async function uploadHandler(req: Request, res: Response) {
  const companyId = req.user!.companyId;
  const file = req.file;
  if (!file) {
    throw new AppError("Archivo no recibido", 400);
  }

  let storagePathAbs = file.path;
  const baseDir = path.resolve(process.cwd(), env.UPLOAD_DIR);
  let relativePath = toForwardSlashes(path.relative(baseDir, storagePathAbs));

  // safety: ensure path is inside expected dir
  if (!relativePath.startsWith(`products/${companyId}/`)) {
    await fs.unlink(storagePathAbs).catch(() => undefined);
    throw new AppError("Ruta de almacenamiento invalida", 500);
  }

  const type = detectType(file.mimetype);
  let ext = path.extname(file.originalname).replace(/^\./, "").toLowerCase() || path.extname(file.filename).replace(/^\./, "").toLowerCase();
  let mimeType = file.mimetype;
  let size = file.size;

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

  const response: UploadedProductFileResponse = {
    type,
    url: buildPublicUrl(relativePath),
    storagePath: relativePath,
    originalName: file.originalname,
    extension: ext,
    mimeType,
    size,
  };

  return res.status(201).json(response);
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
    return next(new AppError(`Archivo demasiado grande (max ${env.MAX_UPLOAD_MB}MB)`, 413));
  }
  return next(err);
}
