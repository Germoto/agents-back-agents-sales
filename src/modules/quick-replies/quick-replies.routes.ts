import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import {
  listCategoriesController,
  createCategoryController,
  updateCategoryController,
  deleteCategoryController,
  listQuickRepliesController,
  createQuickReplyController,
  updateQuickReplyController,
  deleteQuickReplyController,
  sendQuickReplyController,
} from "./quick-replies.controller";
import {
  upsertQuickReplySchema,
  upsertCategorySchema,
  sendQuickReplySchema,
} from "./quick-replies.schemas";

const router = Router();

router.use(requireAuth);

// Categorías primero, para que Express no capture "categories" como :id.
router.get("/categories", asyncHandler(listCategoriesController));
router.post("/categories", validate({ body: upsertCategorySchema }), asyncHandler(createCategoryController));
router.put("/categories/:id", validate({ body: upsertCategorySchema }), asyncHandler(updateCategoryController));
router.delete("/categories/:id", asyncHandler(deleteCategoryController));

router.get("/", asyncHandler(listQuickRepliesController));
router.post("/", validate({ body: upsertQuickReplySchema }), asyncHandler(createQuickReplyController));
router.put("/:id", validate({ body: upsertQuickReplySchema }), asyncHandler(updateQuickReplyController));
router.delete("/:id", asyncHandler(deleteQuickReplyController));
router.post("/:id/send", validate({ body: sendQuickReplySchema }), asyncHandler(sendQuickReplyController));

export default router;
