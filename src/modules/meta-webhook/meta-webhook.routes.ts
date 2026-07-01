import { Router } from "express";
import { verifyWebhookController, inboundWebhookController } from "./meta-webhook.controller";

const router = Router();

// Webhook ÚNICO de la app Meta de la plataforma (todos los tenants META).
// GET: verificación de suscripción (hub.challenge). POST: mensajes + statuses,
// autenticado por firma X-Hub-Signature-256 (no lleva requireAuth).
router.get("/webhook", verifyWebhookController);
router.post("/webhook", inboundWebhookController);

export default router;
