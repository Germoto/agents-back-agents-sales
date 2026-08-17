/** Config del panel para Meta Conversions API (Integraciones → CAPI). */

import { Router } from "express";
import { z } from "zod";
import type { Request, Response } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import { getMetaCapiConfig, updateMetaCapiConfig } from "./meta-capi.service";

const updateSchema = z.object({
  enabled: z.boolean(),
  datasetId: z.string().trim().max(60).default(""),
  // Opcional: vacío conserva el token guardado (nunca se reenvía al panel).
  accessToken: z.string().trim().max(500).optional(),
  // Página de Facebook que corre los anuncios (requerida por Meta en business_messaging).
  pageId: z.string().trim().max(60).nullable().optional(),
  testEventCode: z.string().trim().max(60).nullable().optional(),
});

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => res.json(await getMetaCapiConfig(req.user!.companyId))),
);
router.put(
  "/",
  validate({ body: updateSchema }),
  asyncHandler(async (req: Request, res: Response) =>
    res.json(await updateMetaCapiConfig(req.user!.companyId, req.body)),
  ),
);

export default router;
