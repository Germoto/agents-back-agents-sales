import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import { createProductController, deleteProductController, getProductController, listProductsController, reorderProductsController, toggleProductActiveController, toggleProductCatalogController, updateProductController } from "./products.controller";
import { productBodySchema, productIdParamsSchema } from "./products.schemas";
import { aiSuggestBodySchema, aiSuggestProductFieldController } from "./products.ai";
import {
  analyzeImportController,
  confirmImportController,
  exportProductsController,
  importZipErrorTrap,
  importZipMiddleware,
} from "./product-transfer.controller";
import { confirmImportBodySchema } from "./product-transfer.schemas";

const router = Router();

router.use(requireAuth);
router.get("/", asyncHandler(listProductsController));
router.post("/", validate({ body: productBodySchema }), asyncHandler(createProductController));
router.patch("/reorder", asyncHandler(reorderProductsController));
// Export/import del catálogo (ZIP con manifest + multimedia). ANTES de /:id.
router.post("/export", asyncHandler(exportProductsController));
router.post("/import", importZipMiddleware, importZipErrorTrap, asyncHandler(analyzeImportController));
router.post("/import/confirm", validate({ body: confirmImportBodySchema }), asyncHandler(confirmImportController));
router.post("/ai-suggest", validate({ body: aiSuggestBodySchema }), asyncHandler(aiSuggestProductFieldController));
router.get("/:id", validate({ params: productIdParamsSchema }), asyncHandler(getProductController));
router.put("/:id", validate({ params: productIdParamsSchema, body: productBodySchema }), asyncHandler(updateProductController));
router.patch("/:id/toggle-active", validate({ params: productIdParamsSchema }), asyncHandler(toggleProductActiveController));
router.patch("/:id/toggle-catalog", validate({ params: productIdParamsSchema }), asyncHandler(toggleProductCatalogController));
router.delete("/:id", validate({ params: productIdParamsSchema }), asyncHandler(deleteProductController));

export default router;
