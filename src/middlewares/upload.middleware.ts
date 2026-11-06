import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Request } from "express";
import multer, { FileFilterCallback } from "multer";
import { env } from "../config/env";
import { AppError } from "../lib/app-error";
import { DOCUMENT_EXTS_LABEL, MAX_DOCUMENT_MB, documentExtOfUpload } from "../lib/document-types";

const ALLOWED_MIME_PREFIXES = ["image/", "video/", "audio/"];

function sanitizeExtension(originalName: string, mimeType: string): string {
  // Documentos (pdf, zip, xlsx, …): la extensión del catálogo manda, aunque el
  // navegador haya mandado un MIME genérico (application/octet-stream).
  const docExt = documentExtOfUpload(originalName, mimeType);
  if (docExt) return `.${docExt}`;
  const ext = path.extname(originalName).replace(/[^a-zA-Z0-9.]/g, "").toLowerCase();
  if (ext && ext.length <= 10) {
    return ext;
  }
  // fallback mapping from common mime types
  if (mimeType.startsWith("image/")) return "." + mimeType.split("/")[1];
  if (mimeType.startsWith("video/")) return "." + mimeType.split("/")[1];
  if (mimeType.startsWith("audio/")) return "." + mimeType.split("/")[1];
  return ".bin";
}

/** Storage de archivos de producto; el companyId sale de `getCompanyId` (sesión o enlace de subida). */
function productStorage(getCompanyId: (req: Request) => string | undefined) {
  return multer.diskStorage({
  destination: (req: Request, _file, cb) => {
    const companyId = getCompanyId(req);
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
}

function fileFilter(_req: Request, file: Express.Multer.File, cb: FileFilterCallback) {
  const isAllowed =
    ALLOWED_MIME_PREFIXES.some((prefix) => file.mimetype.startsWith(prefix)) ||
    documentExtOfUpload(file.originalname, file.mimetype) !== null;
  if (!isAllowed) {
    return cb(
      new AppError(
        `Tipo de archivo no permitido (${file.mimetype}). Se admiten imagen, video, audio o archivos ${DOCUMENT_EXTS_LABEL}.`,
        415,
      ),
    );
  }
  cb(null, true);
}

/** Tope de multer = el mayor de los dos límites; el tope por tipo se valida en el servicio. */
export const PRODUCT_FILE_LIMIT_MB = Math.max(env.MAX_UPLOAD_MB, MAX_DOCUMENT_MB);

/** Multer de archivos de producto con el companyId que indique el caller. */
export function makeProductFileUpload(getCompanyId: (req: Request) => string | undefined) {
  return multer({
    storage: productStorage(getCompanyId),
    fileFilter,
    limits: {
      fileSize: PRODUCT_FILE_LIMIT_MB * 1024 * 1024,
    },
  }).single("file");
}

export const uploadProductFileMiddleware = makeProductFileUpload((req) => req.user?.companyId);

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
