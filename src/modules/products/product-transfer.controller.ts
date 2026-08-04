import fs from "fs";
import path from "path";
import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import multer from "multer";
import { env } from "../../config/env";
import { AppError } from "../../lib/app-error";
import { analyzeImport, confirmImport, exportProducts, importTmpDir } from "./product-transfer.service";

// Multer del ZIP de import: a disco (los ZIP con videos pueden pesar cientos
// de MB — nada de memoryStorage), nombre generado por el servidor.
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = importTmpDir();
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, _file, cb) => cb(null, `${crypto.randomUUID()}.zip`),
});

export const importZipMiddleware = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const okMime = ["application/zip", "application/x-zip-compressed", "application/octet-stream"].includes(
      file.mimetype,
    );
    if (ext === ".zip" && okMime) return cb(null, true);
    cb(new AppError("Formato no soportado. Sube el .zip exportado desde FlowApp.", 415));
  },
  limits: { fileSize: env.MAX_IMPORT_MB * 1024 * 1024 },
}).single("file");

export function importZipErrorTrap(err: unknown, _req: Request, _res: Response, next: NextFunction) {
  if (!err) return next();
  if ((err as { code?: string }).code === "LIMIT_FILE_SIZE") {
    return next(new AppError(`Archivo demasiado grande (máx ${env.MAX_IMPORT_MB}MB)`, 413));
  }
  return next(err);
}

export async function exportProductsController(req: Request, res: Response) {
  await exportProducts(req.user!.companyId, res);
}

export async function analyzeImportController(req: Request, res: Response) {
  if (!req.file) throw new AppError("Archivo no recibido", 400);
  const preview = await analyzeImport(req.user!.companyId, req.file.path);
  res.json({ success: true, data: preview });
}

export async function confirmImportController(req: Request, res: Response) {
  const report = await confirmImport(req.user!.companyId, req.body.uploadToken);
  res.json({ success: true, data: report });
}
