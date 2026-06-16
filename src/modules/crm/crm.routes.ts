import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import {
  listCrmsController,
  createCrmController,
  updateCrmController,
  deleteCrmController,
  getBoardController,
  createColumnController,
  updateColumnController,
  deleteColumnController,
  reorderColumnsController,
  moveCardController,
  listTagsController,
  createTagController,
  updateTagController,
  deleteTagController,
  setCustomerTagsController,
  listDealsController,
  createDealController,
  updateDealController,
  deleteDealController,
  funnelController,
} from "./crm.controller";
import {
  upsertCrmSchema,
  upsertColumnSchema,
  reorderColumnsSchema,
  moveCardSchema,
  upsertTagSchema,
  setCustomerTagsSchema,
  upsertDealSchema,
} from "./crm.schemas";

const router = Router();

router.use(requireAuth);

// Rutas estáticas primero (antes de /:id) — Express 5.

// --- Embudo de ventas ---
router.get("/funnel", asyncHandler(funnelController));

// --- Etiquetas internas ---
router.get("/tags", asyncHandler(listTagsController));
router.post("/tags", validate({ body: upsertTagSchema }), asyncHandler(createTagController));
router.put("/tags/:tagId", validate({ body: upsertTagSchema }), asyncHandler(updateTagController));
router.delete("/tags/:tagId", asyncHandler(deleteTagController));
router.put(
  "/customers/:customerId/tags",
  validate({ body: setCustomerTagsSchema }),
  asyncHandler(setCustomerTagsController),
);

// --- Valores de negocio ---
router.get("/customers/:customerId/deals", asyncHandler(listDealsController));
router.post(
  "/customers/:customerId/deals",
  validate({ body: upsertDealSchema }),
  asyncHandler(createDealController),
);
router.put("/deals/:dealId", validate({ body: upsertDealSchema }), asyncHandler(updateDealController));
router.delete("/deals/:dealId", asyncHandler(deleteDealController));

// --- CRMs ---
router.get("/", asyncHandler(listCrmsController));
router.post("/", validate({ body: upsertCrmSchema }), asyncHandler(createCrmController));
router.put("/:id", validate({ body: upsertCrmSchema }), asyncHandler(updateCrmController));
router.delete("/:id", asyncHandler(deleteCrmController));

// --- Board / columnas / move ---
router.get("/:id/board", asyncHandler(getBoardController));
router.post(
  "/:id/columns",
  validate({ body: upsertColumnSchema }),
  asyncHandler(createColumnController),
);
router.patch(
  "/:id/columns/reorder",
  validate({ body: reorderColumnsSchema }),
  asyncHandler(reorderColumnsController),
);
router.put(
  "/:id/columns/:columnId",
  validate({ body: upsertColumnSchema }),
  asyncHandler(updateColumnController),
);
router.delete("/:id/columns/:columnId", asyncHandler(deleteColumnController));
router.patch("/:id/move", validate({ body: moveCardSchema }), asyncHandler(moveCardController));

export default router;
