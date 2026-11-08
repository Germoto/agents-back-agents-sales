import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import { bulkCreateProductsController, copilotChatController, copilotSuggestionsController } from "./copilot.controller";
import { bulkProductsSchema, copilotChatSchema, copilotSuggestionsQuerySchema } from "./copilot.schemas";

const router = Router();

router.use(requireAuth);

router.post("/chat", validate({ body: copilotChatSchema }), asyncHandler(copilotChatController));
// Sugerencias (chips) por modo/paso y rubro.
router.get("/suggestions", validate({ query: copilotSuggestionsQuerySchema }), asyncHandler(copilotSuggestionsController));
// Asistente de arranque (paso 2): crea en lote los productos que el dueño confirmó en la tabla.
router.post("/products/bulk", validate({ body: bulkProductsSchema }), asyncHandler(bulkCreateProductsController));

export default router;
