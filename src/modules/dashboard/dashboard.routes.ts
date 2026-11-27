import { Router } from "express";
import { Request, Response } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import { getDashboardStats, getDashboardExportData, getAdLeads } from "./dashboard.service";
import { dashboardQuerySchema, adLeadsQuerySchema, type DashboardQueryInput, type AdLeadsQueryInput } from "./dashboard.schemas";

const router = Router();

router.use(requireAuth);

// `period` (hoy, esta semana, semana pasada…) se resuelve en la zona del negocio;
// `from`/`to` solo se usan para un rango personalizado.
const paramsOf = (req: Request) => {
  const q = req.query as unknown as DashboardQueryInput;
  return { companyId: req.user!.companyId, period: q.period, from: q.from, to: q.to, productId: q.productId };
};

router.get(
  "/stats",
  validate({ query: dashboardQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await getDashboardStats(paramsOf(req)));
  }),
);

router.get(
  "/export",
  validate({ query: dashboardQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await getDashboardExportData(paramsOf(req)));
  }),
);

// Personas detrás de una fila de «Por anuncio» (quién escribió, quién compró).
router.get(
  "/ad-leads",
  validate({ query: adLeadsQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as AdLeadsQueryInput;
    res.json(await getAdLeads({ ...paramsOf(req), adSourceId: q.adSourceId }));
  }),
);

export default router;
