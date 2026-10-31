import { Router } from "express";
import { optionalAgentApiKey } from "../../middlewares/optional-agent-api-key";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import { conversationsQuerySchema, messagesQuerySchema, updateReminderSchema } from "./conversations.schemas";
import { inboundController } from "./agent.controller";
import {
  listConversationsController,
  getConversationController,
  listMessagesController,
  pauseConversationController,
  pinConversationController,
  optOutConversationController,
  replyConversationController,
  reactConversationController,
  typingConversationController,
  resetConversationController,
  deleteConversationController,
  deleteConversationsBulkController,
  startConversationController,
  scheduleReminderController,
} from "./conversations.controller";
import {
  simulateMessagesController,
  simulateTurnController,
  simulateResetController,
} from "./simulate.controller";
import {
  listRemindersController,
  cancelReminderController,
  cancelClientRemindersController,
  cancelRemindersBulkController,
  updateReminderController,
} from "../scheduler/scheduler.controller";

const router = Router();

// Webhook inbound de WhatsApp. Público (lo llama SMS Tools), protegido
// opcionalmente por x-api-key si AGENT_INBOUND_API_KEY está definido.
router.post("/inbound", optionalAgentApiKey, inboundController);

// Visor de conversaciones para el panel admin (requiere auth de tenant)
router.get("/conversations", requireAuth, validate({ query: conversationsQuerySchema }), listConversationsController);
router.post("/conversations/start", requireAuth, startConversationController);
router.post("/conversations/delete-bulk", requireAuth, deleteConversationsBulkController);
router.get("/conversations/:id/messages", requireAuth, validate({ query: messagesQuerySchema }), listMessagesController);
router.post("/conversations/:id/pause", requireAuth, pauseConversationController);
router.post("/conversations/:id/pin", requireAuth, pinConversationController);
router.post("/conversations/:id/opt-out", requireAuth, optOutConversationController);
router.post("/conversations/:id/reply", requireAuth, replyConversationController);
router.post("/conversations/:id/react", requireAuth, reactConversationController);
router.post("/conversations/:id/typing", requireAuth, typingConversationController);
router.post("/conversations/:id/reminder", requireAuth, scheduleReminderController);
router.post("/conversations/:id/reset", requireAuth, resetConversationController);
// Resumen de una conversación por id (para abrir un chat fuera de los últimos 50).
// Va después de las subrutas /:id/* para no capturarlas.
router.get("/conversations/:id", requireAuth, getConversationController);
router.delete("/conversations/:id", requireAuth, deleteConversationController);

// Simulador del agente (panel > Pruebas): corre el agente real sin enviar por WhatsApp.
router.get("/simulate", requireAuth, simulateMessagesController);
router.post("/simulate", requireAuth, simulateTurnController);
router.post("/simulate/reset", requireAuth, simulateResetController);

// Reservas de servicios (panel)

// Recordatorios programados (panel > Recordatorios > Programados): ver, editar y cancelar.
router.get("/reminders", requireAuth, listRemindersController);
router.patch("/reminders/:id", requireAuth, validate({ body: updateReminderSchema }), updateReminderController);
router.post("/reminders/cancel", requireAuth, cancelClientRemindersController);
router.post("/reminders/cancel-bulk", requireAuth, cancelRemindersBulkController);
router.post("/reminders/:id/cancel", requireAuth, cancelReminderController);

export default router;
