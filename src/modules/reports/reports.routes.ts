import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import {
  getReportConfigController,
  updateReportConfigController,
  sendTestReportController,
} from "./reports.controller";
import { updateReportConfigSchema, testReportSchema } from "./reports.schemas";

const router = Router();

router.use(requireAuth);
router.get("/config", asyncHandler(getReportConfigController));
router.put("/config", validate({ body: updateReportConfigSchema }), asyncHandler(updateReportConfigController));
router.post("/test", validate({ body: testReportSchema }), asyncHandler(sendTestReportController));

export default router;
