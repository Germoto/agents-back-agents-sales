/**
 * Descarga PÚBLICA con enlace firmado de archivos privados de entrega:
 * GET /api/public/dl/:fileId?t=<jwt kind "download">. Sin JWT del panel; el token
 * (7 días) se firma al entregar (correo, página de gracias, agente). Registra un
 * evento DOWNLOAD en la analítica de la tienda.
 */

import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/app-error";
import { prisma } from "../../lib/prisma";
import { verifyDownloadToken } from "../../lib/jwt";
import { resolveOwnUpload } from "../../lib/uploads";
import { makeRateLimiter } from "../../middlewares/rate-limit.middleware";

const router = Router();
const dlLimiter = makeRateLimiter({ windowMs: 5 * 60_000, max: 60, message: "Demasiadas descargas, intenta en unos minutos." });

router.get(
  "/:fileId",
  dlLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const fileId = String(req.params.fileId ?? "");
    const token = String(req.query.t ?? "");
    let payload;
    try {
      payload = verifyDownloadToken(token);
    } catch {
      throw new AppError("El enlace de descarga no es válido o venció. Pide uno nuevo al negocio.", 403);
    }
    if (payload.fileId !== fileId) throw new AppError("Enlace de descarga inválido", 403);
    const file = await prisma.productFile.findFirst({
      where: { id: fileId, product: { companyId: payload.companyId } },
      select: { id: true, storagePath: true, originalName: true, mimeType: true, productId: true, product: { select: { companyId: true } } },
    });
    if (!file) throw new AppError("Archivo no encontrado", 404);
    const resolved = await resolveOwnUpload(file.storagePath, { companyId: file.product.companyId });
    if (!resolved) throw new AppError("Archivo no disponible", 404);
    void prisma.storeEvent
      .create({ data: { companyId: file.product.companyId, type: "DOWNLOAD", productId: file.productId, sessionId: payload.ref ?? "link" } })
      .catch(() => undefined);
    if (file.mimeType) res.type(file.mimeType);
    res.setHeader("Cache-Control", "private, no-store");
    const name = file.originalName || resolved.fileName;
    return res.download(resolved.filePath, name);
  }),
);

export default router;
