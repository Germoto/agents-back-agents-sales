/**
 * Subida PÚBLICA del comprobante Yape/Plin de un pedido de la tienda web.
 * Molde: webchat-upload.middleware.ts. Solo imágenes, 10 MB, destino
 * `uploads/inbound/store/<companyId>/` (misma URL pública que la media entrante
 * de WhatsApp, usable por el panel y por la visión).
 *
 * `storeOrderAccess` resuelve ANTES el pedido por id + token (`?t=`) y lo deja en
 * `req.storeOrder` para que el destino de multer conozca el companyId.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import multer, { FileFilterCallback } from "multer";
import { env } from "../../config/env";
import { AppError } from "../../lib/app-error";
import { prisma } from "../../lib/prisma";

const MAX_UPLOAD_MB = 10;

export type StoreOrderRequest = Request & {
  storeOrder?: { id: string; companyId: string };
};

export async function storeOrderAccess(req: Request, _res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id ?? "");
    const token = String(req.query.t ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(id) || token.length < 8) throw new AppError("Pedido no encontrado", 404);
    const order = await prisma.storeOrder.findUnique({ where: { id }, select: { id: true, companyId: true, accessToken: true } });
    if (!order || order.accessToken !== token) throw new AppError("Pedido no encontrado", 404);
    (req as StoreOrderRequest).storeOrder = { id: order.id, companyId: order.companyId };
    next();
  } catch (err) {
    next(err);
  }
}

function sanitizeExtension(originalName: string, mimeType: string): string {
  const ext = path.extname(originalName).replace(/[^a-zA-Z0-9.]/g, "").toLowerCase();
  if (ext && ext.length <= 10) return ext;
  if (mimeType.startsWith("image/")) return "." + mimeType.split("/")[1];
  return ".jpg";
}

const storage = multer.diskStorage({
  destination: (req: Request, _file, cb) => {
    const companyId = (req as StoreOrderRequest).storeOrder?.companyId;
    if (!companyId) return cb(new AppError("Pedido no encontrado", 404), "");
    const dir = path.resolve(process.cwd(), env.UPLOAD_DIR, "inbound", "store", companyId);
    fs.mkdir(dir, { recursive: true }, (err) => {
      if (err) return cb(err, dir);
      cb(null, dir);
    });
  },
  filename: (_req, file, cb) => {
    cb(null, `${crypto.randomUUID()}${sanitizeExtension(file.originalname, file.mimetype)}`);
  },
});

function fileFilter(_req: Request, file: Express.Multer.File, cb: FileFilterCallback) {
  if (!file.mimetype.startsWith("image/")) return cb(new AppError("Sube una imagen (captura) del comprobante", 415));
  cb(null, true);
}

export const storeReceiptUploadMiddleware = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
}).single("file");

/** URL pública del archivo subido (servida por /uploads). */
export function storeReceiptPublicUrl(companyId: string, filename: string): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/uploads/inbound/store/${companyId}/${filename}`;
}
