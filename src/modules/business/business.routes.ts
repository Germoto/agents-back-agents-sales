import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import { getBusinessProfileController, updateBusinessProfileController } from "./business.controller";
import { updateBusinessSchema } from "./business.schemas";

const router = Router();

router.use(requireAuth);
router.get("/profile", asyncHandler(getBusinessProfileController));
router.put("/profile", validate({ body: updateBusinessSchema }), asyncHandler(updateBusinessProfileController));

export default router;
