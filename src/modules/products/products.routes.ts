import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import { createProductController, deleteProductController, getProductController, listProductsController, toggleProductActiveController, updateProductController } from "./products.controller";
import { productBodySchema, productIdParamsSchema } from "./products.schemas";
import { aiSuggestBodySchema, aiSuggestProductFieldController } from "./products.ai";

const router = Router();

router.use(requireAuth);
router.get("/", asyncHandler(listProductsController));
router.post("/", validate({ body: productBodySchema }), asyncHandler(createProductController));
router.post("/ai-suggest", validate({ body: aiSuggestBodySchema }), asyncHandler(aiSuggestProductFieldController));
router.get("/:id", validate({ params: productIdParamsSchema }), asyncHandler(getProductController));
router.put("/:id", validate({ params: productIdParamsSchema, body: productBodySchema }), asyncHandler(updateProductController));
router.patch("/:id/toggle-active", validate({ params: productIdParamsSchema }), asyncHandler(toggleProductActiveController));
router.delete("/:id", validate({ params: productIdParamsSchema }), asyncHandler(deleteProductController));

export default router;
