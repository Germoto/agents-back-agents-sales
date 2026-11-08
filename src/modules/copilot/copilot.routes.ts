import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import {
  bulkCreateProductsController,
  copilotChatController,
  copilotChatStreamController,
  copilotSuggestionsController,
  getCopilotThreadController,
  putCopilotThreadController,
} from "./copilot.controller";
import { bulkProductsSchema, copilotChatSchema, copilotSuggestionsQuerySchema, putCopilotThreadSchema } from "./copilot.schemas";

const router = Router();

router.use(requireAuth);

router.post("/chat", validate({ body: copilotChatSchema }), asyncHandler(copilotChatController));
// Mismo turno en vivo (SSE): progreso de herramientas + texto final por fragmentos.
router.post("/chat/stream", validate({ body: copilotChatSchema }), asyncHandler(copilotChatStreamController));
// Historial por usuario (panel | onboarding).
router.get("/thread", asyncHandler(getCopilotThreadController));
router.put("/thread", validate({ body: putCopilotThreadSchema }), asyncHandler(putCopilotThreadController));
// Sugerencias (chips) por modo/paso y rubro.
router.get("/suggestions", validate({ query: copilotSuggestionsQuerySchema }), asyncHandler(copilotSuggestionsController));
// Asistente de arranque (paso 2): crea en lote los productos que el dueño confirmó en la tabla.
router.post("/products/bulk", validate({ body: bulkProductsSchema }), asyncHandler(bulkCreateProductsController));

export default router;
