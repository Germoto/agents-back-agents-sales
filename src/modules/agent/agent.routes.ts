import { Router } from "express";
import { optionalAgentApiKey } from "../../middlewares/optional-agent-api-key";
import { requireAuth } from "../../middlewares/auth.middleware";
import { inboundController } from "./agent.controller";
import {
  listConversationsController,
  listMessagesController,
  pauseConversationController,
  replyConversationController,
  resetConversationController,
} from "./conversations.controller";
import { listBookingsController, updateBookingStatusController } from "./bookings.controller";
import {
  simulateMessagesController,
  simulateTurnController,
  simulateResetController,
} from "./simulate.controller";
import {
  listRemindersController,
  cancelReminderController,
  cancelClientRemindersController,
} from "../scheduler/scheduler.controller";

const router = Router();

// Webhook inbound de WhatsApp. Público (lo llama SMS Tools), protegido
// opcionalmente por x-api-key si AGENT_INBOUND_API_KEY está definido.
router.post("/inbound", optionalAgentApiKey, inboundController);

// Visor de conversaciones para el panel admin (requiere auth de tenant)
router.get("/conversations", requireAuth, listConversationsController);
router.get("/conversations/:id/messages", requireAuth, listMessagesController);
router.post("/conversations/:id/pause", requireAuth, pauseConversationController);
router.post("/conversations/:id/reply", requireAuth, replyConversationController);
router.post("/conversations/:id/reset", requireAuth, resetConversationController);

// Simulador del agente (panel > Pruebas): corre el agente real sin enviar por WhatsApp.
router.get("/simulate", requireAuth, simulateMessagesController);
router.post("/simulate", requireAuth, simulateTurnController);
router.post("/simulate/reset", requireAuth, simulateResetController);

// Reservas de servicios (panel)
router.get("/bookings", requireAuth, listBookingsController);
router.post("/bookings/:id/status", requireAuth, updateBookingStatusController);

// Recordatorios programados (panel > Recordatorios > Programados): ver y cancelar.
router.get("/reminders", requireAuth, listRemindersController);
router.post("/reminders/cancel", requireAuth, cancelClientRemindersController);
router.post("/reminders/:id/cancel", requireAuth, cancelReminderController);

export default router;
