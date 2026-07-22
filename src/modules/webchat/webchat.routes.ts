/**
 * Rutas PÚBLICAS del chat web embebible (/api/webchat). Sin billingGuard: el
 * gate de leads se aplica adentro (createSession) igual que el inbound de
 * WhatsApp. Rate limiting: sesiones por IP y mensajes por sesión (cada mensaje
 * corre el agente = costo OpenAI del tenant).
 */

import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { validate } from "../../middlewares/validate";
import { makeRateLimiter } from "../../middlewares/rate-limit.middleware";
import { requireWebchatSession, type WebchatRequest } from "./webchat-auth.middleware";
import { webchatUploadMiddleware } from "./webchat-upload.middleware";
import { createSessionSchema, postMessageSchema } from "./webchat.schemas";
import {
  createSessionController,
  getHistoryController,
  postMessageController,
  postUploadController,
} from "./webchat.controller";

const router = Router();

const sessionLimiter = makeRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: "Demasiadas sesiones desde esta IP. Intenta más tarde.",
});

const messageLimiter = makeRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  message: "Estás escribiendo muy rápido. Espera un momento.",
  keyGenerator: (req) => (req as WebchatRequest).webchat?.conversationId ?? req.ip ?? "anon",
});

const uploadLimiter = makeRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: "Demasiadas imágenes seguidas. Espera un momento.",
  keyGenerator: (req) => (req as WebchatRequest).webchat?.conversationId ?? req.ip ?? "anon",
});

router.post("/session", sessionLimiter, validate({ body: createSessionSchema }), asyncHandler(createSessionController));
router.get("/history", requireWebchatSession, asyncHandler(getHistoryController));
router.post(
  "/message",
  requireWebchatSession,
  messageLimiter,
  validate({ body: postMessageSchema }),
  asyncHandler(postMessageController),
);
// Imagen del visitante (constancia Yape/Plin): pasa por el pipeline de comprobantes
router.post(
  "/upload",
  requireWebchatSession,
  uploadLimiter,
  webchatUploadMiddleware,
  asyncHandler(postUploadController),
);

export default router;
