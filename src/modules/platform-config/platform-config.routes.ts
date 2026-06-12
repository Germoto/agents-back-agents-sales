import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { getLandingScene } from "./platform-config.service";

const router = Router();

// Config pública del landing (sin auth): qué animación 3D renderizar.
router.get(
  "/",
  asyncHandler(async (_req, res) => {
    const scene = await getLandingScene();
    return res.json({ scene });
  }),
);

export default router;
