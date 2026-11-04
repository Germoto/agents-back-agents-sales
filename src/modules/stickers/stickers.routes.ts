import { Router, Request, Response } from "express";
import multer from "multer";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/app-error";
import { requireAuth } from "../../middlewares/auth.middleware";
import { deleteSticker, listStickers, saveReceivedSticker, STICKER_UPLOAD_LIMIT, uploadSticker } from "./stickers.service";

const router = Router();
router.use(requireAuth);

// En memoria: el archivo se convierte con sharp y se escribe ya como .webp.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: STICKER_UPLOAD_LIMIT, files: 1 } });

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await listStickers(req.user!.companyId) });
  }),
);

router.post(
  "/upload",
  (req, res, next) =>
    upload.single("file")(req, res, (err) => {
      if (err) return next(new AppError(err.code === "LIMIT_FILE_SIZE" ? "La imagen supera los 5 MB" : "No se pudo subir la imagen", 400));
      next();
    }),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw new AppError("Archivo no recibido", 400);
    const data = await uploadSticker(req.user!.companyId, req.file);
    res.status(201).json({ success: true, data });
  }),
);

router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const url = String(req.body?.url ?? "").trim();
    if (!url) throw new AppError("Falta la URL del sticker", 400);
    const data = await saveReceivedSticker(req.user!.companyId, url);
    res.status(data.existed ? 200 : 201).json({ success: true, data });
  }),
);

router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    await deleteSticker(req.user!.companyId, String(req.params.id));
    res.json({ success: true });
  }),
);

export default router;
