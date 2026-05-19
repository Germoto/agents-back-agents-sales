import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { uploadProductFileMiddleware } from "../../middlewares/upload.middleware";
import {
  deleteOrphanHandler,
  deletePersistedHandler,
  uploadErrorTrap,
  uploadHandler,
} from "./product-files.service";

const router = Router();

router.use(requireAuth);

router.post(
  "/",
  (req, res, next) => uploadProductFileMiddleware(req, res, (err) => uploadErrorTrap(err, req, res, next)),
  asyncHandler(uploadHandler),
);

router.post("/orphan-delete", asyncHandler(deleteOrphanHandler));
router.delete("/:id", asyncHandler(deletePersistedHandler));

export default router;
