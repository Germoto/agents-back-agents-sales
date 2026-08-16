/** Rutas del panel para el Catálogo de anuncios (Empresa → Anuncios). */

import { Router } from "express";
import { z } from "zod";
import type { Request, Response } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import {
  listAdCatalog,
  createAdCatalogEntry,
  updateAdCatalogEntry,
  deleteAdCatalogEntry,
} from "./ad-catalog.service";

const upsertSchema = z.object({
  description: z.string().trim().min(1).max(160),
  matchers: z.array(z.string().trim().min(1).max(300)).min(1).max(30),
  // Producto relacionado (opcional): null lo quita.
  productId: z.string().uuid().nullable().optional(),
});

const router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => res.json(await listAdCatalog(req.user!.companyId))),
);
router.post(
  "/",
  validate({ body: upsertSchema }),
  asyncHandler(async (req: Request, res: Response) =>
    res.status(201).json(await createAdCatalogEntry(req.user!.companyId, req.body)),
  ),
);
router.put(
  "/:id",
  validate({ body: upsertSchema.partial() }),
  asyncHandler(async (req: Request, res: Response) =>
    res.json(await updateAdCatalogEntry(req.user!.companyId, String(req.params.id), req.body)),
  ),
);
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    await deleteAdCatalogEntry(req.user!.companyId, String(req.params.id));
    return res.json({ ok: true });
  }),
);

export default router;
