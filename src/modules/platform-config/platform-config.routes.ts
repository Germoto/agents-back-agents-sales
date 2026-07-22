import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { getLandingScene, getPublicSalesChatToken } from "./platform-config.service";

const router = Router();

// Config pública del landing (sin auth): animación 3D + token del chat de
// ventas de la plataforma (null si aún no está configurado → sin burbuja).
router.get(
  "/",
  asyncHandler(async (_req, res) => {
    const [scene, salesToken] = await Promise.all([getLandingScene(), getPublicSalesChatToken()]);
    return res.json({ scene, salesChat: salesToken ? { token: salesToken } : null });
  }),
);

export default router;
