import fs from "fs/promises";
import path from "path";
import type { Request, Response, NextFunction } from "express";
import type { TrainingResource } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { env } from "../../config/env";
import { ensureMetaCompatibleVideo } from "../../lib/video-transcode";
import { extractYoutubeId, type TrainingResourceInput } from "./training.schemas";

// ---------------------------------------------------------------------------
// Recursos de capacitación globales — CRUD del superadmin + upload de archivos
// a la carpeta fija `training/` (sin companyId). Molde: billing-admin.service
// (CRUD) y product-files.service (upload / borrado físico).
// ---------------------------------------------------------------------------

function toForwardSlashes(p: string) {
  return p.replace(/\\/g, "/");
}

function buildPublicUrl(storagePathRel: string) {
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  return `${base}/uploads/${storagePathRel}`;
}

function ensureSafeTrainingPath(storagePath: string): string {
  const normalized = toForwardSlashes(storagePath).replace(/^\/+/, "");
  if (!normalized.startsWith("training/") || normalized.includes("..")) {
    throw new AppError("Ruta de archivo invalida", 400);
  }
  return normalized;
}

async function deletePhysicalFile(storagePathRel: string) {
  const absolute = path.resolve(process.cwd(), env.UPLOAD_DIR, storagePathRel);
  try {
    await fs.unlink(absolute);
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.warn("[training] No se pudo eliminar archivo:", absolute, err?.message);
    }
  }
}

export function mapResource(r: TrainingResource) {
  const isUploaded = r.type === "PDF" || r.type === "VIDEO";
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    type: r.type,
    url: isUploaded ? (r.storagePath ? buildPublicUrl(r.storagePath) : null) : r.url,
    youtubeId: r.type === "YOUTUBE" && r.url ? extractYoutubeId(r.url) : null,
    storagePath: r.storagePath,
    mimeType: r.mimeType,
    size: r.size,
    sortOrder: r.sortOrder,
    isActive: r.isActive,
    createdAt: r.createdAt,
  };
}

export type TrainingResourceDto = ReturnType<typeof mapResource>;

const DEFAULT_ORDER = [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }];

// ---------------- CRUD (superadmin) ----------------

export async function listResources() {
  const rows = await prisma.trainingResource.findMany({ orderBy: DEFAULT_ORDER });
  return rows.map(mapResource);
}

export async function createResource(input: TrainingResourceInput) {
  const created = await prisma.trainingResource.create({ data: input });
  return mapResource(created);
}

export async function updateResource(id: string, input: TrainingResourceInput) {
  const existing = await prisma.trainingResource.findUnique({ where: { id } });
  if (!existing) throw new AppError("Recurso no encontrado", 404);

  // Si el archivo subido cambió (reemplazo) o el recurso pasó a ser un enlace,
  // el archivo físico anterior queda huérfano: se elimina.
  if (existing.storagePath && existing.storagePath !== input.storagePath) {
    await deletePhysicalFile(ensureSafeTrainingPath(existing.storagePath));
  }

  const updated = await prisma.trainingResource.update({ where: { id }, data: input });
  return mapResource(updated);
}

export async function deleteResource(id: string) {
  const existing = await prisma.trainingResource.findUnique({ where: { id } });
  if (!existing) throw new AppError("Recurso no encontrado", 404);
  if (existing.storagePath) {
    await deletePhysicalFile(ensureSafeTrainingPath(existing.storagePath));
  }
  await prisma.trainingResource.delete({ where: { id } });
}

// ---------------- Lectura (tenant) ----------------

export async function listActiveResources() {
  const rows = await prisma.trainingResource.findMany({
    where: { isActive: true },
    orderBy: DEFAULT_ORDER,
  });
  return rows.map(mapResource);
}

// ---------------- Upload ----------------

export async function uploadTrainingHandler(req: Request, res: Response) {
  const file = req.file;
  if (!file) throw new AppError("Archivo no recibido", 400);

  let storagePathAbs = file.path;
  const baseDir = path.resolve(process.cwd(), env.UPLOAD_DIR);
  let relativePath = toForwardSlashes(path.relative(baseDir, storagePathAbs));

  if (!relativePath.startsWith("training/")) {
    await fs.unlink(storagePathAbs).catch(() => undefined);
    throw new AppError("Ruta de almacenamiento invalida", 500);
  }

  const isVideo = file.mimetype.startsWith("video/");
  let mimeType = file.mimetype;
  let size = file.size;

  // Normalizar video a H.264/AAC mp4 para que se reproduzca en todos los
  // navegadores (HEVC de iPhone no corre en Chrome). Best-effort: si la
  // conversión falla se conserva el original.
  if (isVideo) {
    const result = await ensureMetaCompatibleVideo(storagePathAbs);
    if (result.changed) {
      storagePathAbs = result.path;
      relativePath = toForwardSlashes(path.relative(baseDir, storagePathAbs));
      mimeType = "video/mp4";
      size = (await fs.stat(storagePathAbs)).size;
    }
  }

  return res.status(201).json({
    type: isVideo ? "VIDEO" : "PDF",
    url: buildPublicUrl(relativePath),
    storagePath: relativePath,
    originalName: file.originalname,
    mimeType,
    size,
  });
}

export async function deleteOrphanTrainingHandler(req: Request, res: Response) {
  const storagePath = req.body?.storagePath;
  if (typeof storagePath !== "string" || !storagePath.length) {
    throw new AppError("storagePath requerido", 400);
  }
  await deletePhysicalFile(ensureSafeTrainingPath(storagePath));
  return res.json({ success: true });
}

export function trainingUploadErrorTrap(err: any, _req: Request, _res: Response, next: NextFunction) {
  if (!err) return next();
  if (err.code === "LIMIT_FILE_SIZE") {
    return next(new AppError(`Archivo demasiado grande (max ${env.MAX_TRAINING_UPLOAD_MB}MB)`, 413));
  }
  return next(err);
}
