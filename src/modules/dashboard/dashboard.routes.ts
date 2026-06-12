import { Router } from "express";
import { Request, Response } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { getDashboardStats } from "./dashboard.service";

const router = Router();

router.use(requireAuth);

router.get(
  "/stats",
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await getDashboardStats(req.user!.companyId));
  }),
);

export default router;
