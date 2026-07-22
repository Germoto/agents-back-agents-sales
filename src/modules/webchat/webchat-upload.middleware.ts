/**
 * Multer para las imágenes que sube el VISITANTE del chat web (constancias de
 * pago Yape/Plin). Mismo destino que la media entrante de WhatsApp
 * (`uploads/inbound/<companyId>/`, ver lib/inbound-media.ts) para que la URL
 * pública sirva igual al panel y a la visión de OpenAI. Solo imágenes, 10 MB.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Request } from "express";
import multer, { FileFilterCallback } from "multer";
import { env } from "../../config/env";
import { AppError } from "../../lib/app-error";
import type { WebchatRequest } from "./webchat-auth.middleware";

const MAX_WEBCHAT_UPLOAD_MB = 10;

function sanitizeExtension(originalName: string, mimeType: string): string {
  const ext = path.extname(originalName).replace(/[^a-zA-Z0-9.]/g, "").toLowerCase();
  if (ext && ext.length <= 10) return ext;
  if (mimeType.startsWith("image/")) return "." + mimeType.split("/")[1];
  return ".jpg";
}

const storage = multer.diskStorage({
  destination: (req: Request, _file, cb) => {
    const companyId = (req as WebchatRequest).webchat?.companyId;
    if (!companyId) {
      return cb(new AppError("Sesión requerida", 401), "");
    }
    const dir = path.resolve(process.cwd(), env.UPLOAD_DIR, "inbound", companyId);
    fs.mkdir(dir, { recursive: true }, (err) => {
      if (err) return cb(err, dir);
      cb(null, dir);
    });
  },
  filename: (_req, file, cb) => {
    const ext = sanitizeExtension(file.originalname, file.mimetype);
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

function fileFilter(_req: Request, file: Express.Multer.File, cb: FileFilterCallback) {
  if (!file.mimetype.startsWith("image/")) {
    return cb(new AppError("Solo se pueden enviar imágenes", 415));
  }
  cb(null, true);
}

export const webchatUploadMiddleware = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_WEBCHAT_UPLOAD_MB * 1024 * 1024 },
}).single("file");
