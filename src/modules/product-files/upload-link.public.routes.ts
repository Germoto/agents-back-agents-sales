/**
 * Enlace temporal de SUBIDA a un producto (sin login): lo genera el Copiloto/MCP
 * con crear_enlace_subida y el dueño lo abre en flowapp.pe/subir/<token> para
 * arrastrar archivos desde su celular o computadora. Token JWT `product-upload`
 * de 30 min atado a {companyId, productId}; tope de archivos por enlace.
 *
 *   GET  /api/public/upload/:token  → datos para la página (producto, negocio, vence, subidos)
 *   POST /api/public/upload/:token  → multipart `file` → se agrega como ProductFile on-demand
 */

import { Router, type NextFunction, type Request, type Response } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/app-error";
import { prisma } from "../../lib/prisma";
import { verifyProductUploadToken, type ProductUploadJwtPayload } from "../../lib/jwt";
import { makeRateLimiter } from "../../middlewares/rate-limit.middleware";
import { makeProductFileUpload } from "../../middlewares/upload.middleware";
import { finalizeUploadedFile, uploadErrorTrap } from "./product-files.service";

export const MAX_FILES_PER_UPLOAD_LINK = 30;

/** Archivos subidos por enlace (jti → nombres). En memoria: si el proceso reinicia, el tope se reinicia. */
const uploadedByLink = new Map<string, { names: Array<{ name: string; type: string }>; expiresAt: number }>();
function bucketFor(jti: string, exp?: number) {
  const now = Date.now();
  for (const [k, v] of uploadedByLink) if (v.expiresAt < now) uploadedByLink.delete(k);
  let b = uploadedByLink.get(jti);
  if (!b) {
    b = { names: [], expiresAt: (exp ? exp * 1000 : now + 30 * 60_000) + 60_000 };
    uploadedByLink.set(jti, b);
  }
  return b;
}

type UploadLinkRequest = Request & { uploadLink?: ProductUploadJwtPayload };

function readToken(req: Request): ProductUploadJwtPayload {
  try {
    return verifyProductUploadToken(String(req.params.token ?? ""));
  } catch (err) {
    const expired = err instanceof Error && err.name === "TokenExpiredError";
    throw new AppError(expired ? "El enlace venció. Pide uno nuevo al asistente." : "El enlace de subida no es válido.", expired ? 410 : 403);
  }
}

const router = Router();
const limiter = makeRateLimiter({ windowMs: 15 * 60_000, max: 60, message: "Demasiadas subidas seguidas; espera unos minutos." });

router.get(
  "/:token",
  limiter,
  asyncHandler(async (req: Request, res: Response) => {
    const t = readToken(req);
    const product = await prisma.product.findFirst({
      where: { id: t.productId, companyId: t.companyId },
      select: { name: true, company: { select: { name: true } } },
    });
    if (!product) throw new AppError("El producto ya no existe.", 404);
    const b = bucketFor(t.jti, t.exp);
    res.json({
      success: true,
      data: {
        productName: product.name,
        companyName: product.company.name,
        expiresAt: t.exp ? new Date(t.exp * 1000).toISOString() : null,
        maxFiles: MAX_FILES_PER_UPLOAD_LINK,
        uploaded: b.names,
      },
    });
  }),
);

const uploadMw = makeProductFileUpload((req) => (req as UploadLinkRequest).uploadLink?.companyId);

router.post(
  "/:token",
  limiter,
  // Verificar el token ANTES de que multer escriba en disco.
  asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const t = readToken(req);
    const exists = await prisma.product.findFirst({ where: { id: t.productId, companyId: t.companyId }, select: { id: true } });
    if (!exists) throw new AppError("El producto ya no existe.", 404);
    if (bucketFor(t.jti, t.exp).names.length >= MAX_FILES_PER_UPLOAD_LINK) {
      throw new AppError(`Este enlace ya recibió ${MAX_FILES_PER_UPLOAD_LINK} archivos. Pide uno nuevo si necesitas subir más.`, 429);
    }
    (req as UploadLinkRequest).uploadLink = t;
    next();
  }),
  (req, res, next) => uploadMw(req, res, (err) => uploadErrorTrap(err, req, res, next)),
  asyncHandler(async (req: Request, res: Response) => {
    const t = (req as UploadLinkRequest).uploadLink!;
    if (!req.file) throw new AppError("Archivo no recibido", 400);
    const saved = await finalizeUploadedFile(t.companyId, req.file);
    const last = await prisma.productFile.findFirst({ where: { productId: t.productId }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
    const row = await prisma.productFile.create({
      data: {
        productId: t.productId,
        type: saved.type,
        url: saved.url,
        storagePath: saved.storagePath,
        originalName: saved.originalName,
        extension: saved.extension,
        mimeType: saved.mimeType,
        size: saved.size,
        description: "",
        sortOrder: (last?.sortOrder ?? -1) + 1,
        // Llegan on-demand: el Copiloto decide luego cuáles van en la ficha.
        showInPresentation: false,
      },
      select: { id: true, type: true, url: true, originalName: true },
    });
    bucketFor(t.jti, t.exp).names.push({ name: row.originalName, type: row.type });
    res.status(201).json({ success: true, data: { id: row.id, name: row.originalName, type: row.type, url: row.url } });
  }),
);

export default router;
