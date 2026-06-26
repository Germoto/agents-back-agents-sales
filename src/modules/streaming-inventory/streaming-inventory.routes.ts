import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import {
  listCredentialsController,
  createCredentialsController,
  updateCredentialController,
  deleteCredentialController,
} from "./streaming-inventory.controller";

const router = Router();

router.use(requireAuth);
router.get("/", asyncHandler(listCredentialsController));
router.post("/", asyncHandler(createCredentialsController));
router.put("/:id", asyncHandler(updateCredentialController));
router.delete("/:id", asyncHandler(deleteCredentialController));

export default router;
