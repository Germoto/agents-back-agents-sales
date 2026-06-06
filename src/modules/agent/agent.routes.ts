import { Router } from "express";
import { optionalAgentApiKey } from "../../middlewares/optional-agent-api-key";
import { requireAuth } from "../../middlewares/auth.middleware";
import { inboundController } from "./agent.controller";
import {
  listConversationsController,
  listMessagesController,
  pauseConversationController,
} from "./conversations.controller";
import { listBookingsController, updateBookingStatusController } from "./bookings.controller";

const router = Router();

// Webhook inbound de WhatsApp. Público (lo llama SMS Tools), protegido
// opcionalmente por x-api-key si AGENT_INBOUND_API_KEY está definido.
router.post("/inbound", optionalAgentApiKey, inboundController);

// Visor de conversaciones para el panel admin (requiere auth de tenant)
router.get("/conversations", requireAuth, listConversationsController);
router.get("/conversations/:id/messages", requireAuth, listMessagesController);
router.post("/conversations/:id/pause", requireAuth, pauseConversationController);

// Reservas de servicios (panel)
router.get("/bookings", requireAuth, listBookingsController);
router.post("/bookings/:id/status", requireAuth, updateBookingStatusController);

export default router;
