import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Request } from "express";
import multer, { FileFilterCallback } from "multer";
import { env } from "../config/env";
import { AppError } from "../lib/app-error";

const ALLOWED_MIME_PREFIXES = ["image/", "video/", "audio/"];
const ALLOWED_EXACT_MIME = new Set(["application/pdf"]);

function sanitizeExtension(originalName: string, mimeType: string): string {
  const ext = path.extname(originalName).replace(/[^a-zA-Z0-9.]/g, "").toLowerCase();
  if (ext && ext.length <= 10) {
    return ext;
  }
  // fallback mapping from common mime types
  if (mimeType === "application/pdf") return ".pdf";
  if (mimeType.startsWith("image/")) return "." + mimeType.split("/")[1];
  if (mimeType.startsWith("video/")) return "." + mimeType.split("/")[1];
  if (mimeType.startsWith("audio/")) return "." + mimeType.split("/")[1];
  return ".bin";
}

const storage = multer.diskStorage({
  destination: (req: Request, _file, cb) => {
    const companyId = req.user?.companyId;
    if (!companyId) {
      return cb(new AppError("No autenticado", 401), "");
    }
    const dir = path.resolve(process.cwd(), env.UPLOAD_DIR, "products", companyId);
    fs.mkdir(dir, { recursive: true }, (err) => {
      if (err) return cb(err, dir);
      cb(null, dir);
    });
  },
  filename: (_req, file, cb) => {
    const ext = sanitizeExtension(file.originalname, file.mimetype);
    const id = crypto.randomUUID();
    cb(null, `${id}${ext}`);
  },
});

function fileFilter(_req: Request, file: Express.Multer.File, cb: FileFilterCallback) {
  const isAllowed =
    ALLOWED_MIME_PREFIXES.some((prefix) => file.mimetype.startsWith(prefix)) ||
    ALLOWED_EXACT_MIME.has(file.mimetype);
  if (!isAllowed) {
    return cb(new AppError(`Tipo de archivo no permitido: ${file.mimetype}`, 415));
  }
  cb(null, true);
}

export const uploadProductFileMiddleware = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: env.MAX_UPLOAD_MB * 1024 * 1024,
  },
}).single("file");

// ---------------------------------------------------------------------------
// Recursos de capacitación (superadmin): carpeta global fija `training/`
// (sin companyId) y solo manuales PDF o videos, con su propio límite.
// ---------------------------------------------------------------------------

const trainingStorage = multer.diskStorage({
  destination: (_req: Request, _file, cb) => {
    const dir = path.resolve(process.cwd(), env.UPLOAD_DIR, "training");
    fs.mkdir(dir, { recursive: true }, (err) => {
      if (err) return cb(err, dir);
      cb(null, dir);
    });
  },
  filename: (_req, file, cb) => {
    const ext = sanitizeExtension(file.originalname, file.mimetype);
    const id = crypto.randomUUID();
    cb(null, `${id}${ext}`);
  },
});

function trainingFileFilter(_req: Request, file: Express.Multer.File, cb: FileFilterCallback) {
  const isAllowed = file.mimetype.startsWith("video/") || file.mimetype === "application/pdf";
  if (!isAllowed) {
    return cb(new AppError(`Tipo de archivo no permitido: ${file.mimetype} (solo PDF o video)`, 415));
  }
  cb(null, true);
}

export const uploadTrainingFileMiddleware = multer({
  storage: trainingStorage,
  fileFilter: trainingFileFilter,
  limits: {
    fileSize: env.MAX_TRAINING_UPLOAD_MB * 1024 * 1024,
  },
}).single("file");
