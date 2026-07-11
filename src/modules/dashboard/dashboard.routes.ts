import { Router } from "express";
import { Request, Response } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { getDashboardStats, getDashboardExportData } from "./dashboard.service";

const router = Router();

router.use(requireAuth);

router.get(
  "/stats",
  asyncHandler(async (req: Request, res: Response) => {
    const { from, to, productId } = req.query;
    res.json(
      await getDashboardStats({
        companyId: req.user!.companyId,
        from: typeof from === "string" && from ? from : undefined,
        to: typeof to === "string" && to ? to : undefined,
        productId: typeof productId === "string" && productId ? productId : undefined,
      }),
    );
  }),
);

router.get(
  "/export",
  asyncHandler(async (req: Request, res: Response) => {
    const { from, to, productId } = req.query;
    res.json(
      await getDashboardExportData({
        companyId: req.user!.companyId,
        from: typeof from === "string" && from ? from : undefined,
        to: typeof to === "string" && to ? to : undefined,
        productId: typeof productId === "string" && productId ? productId : undefined,
      }),
    );
  }),
);

export default router;
