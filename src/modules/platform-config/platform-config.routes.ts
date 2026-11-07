import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { getLandingConfig, getPublicSalesChatToken } from "./platform-config.service";

const router = Router();

// Config pública del landing (sin auth): animación 3D + token del chat de
// ventas de la plataforma (null si aún no está configurado → sin burbuja).
router.get(
  "/",
  asyncHandler(async (_req, res) => {
    const [{ scene, accent }, salesToken] = await Promise.all([getLandingConfig(), getPublicSalesChatToken()]);
    return res.json({ scene, accent, salesChat: salesToken ? { token: salesToken } : null });
  }),
);

export default router;
