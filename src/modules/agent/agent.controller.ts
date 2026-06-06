import { Request, Response } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { parseInboundWebhook } from "../../lib/smstools-client";
import { handleInbound } from "./agent.service";

/**
 * Webhook inbound de WhatsApp (SMS Tools). Responde 200 de inmediato y procesa
 * el turno del agente en background: SMS Tools reintenta si la respuesta tarda,
 * y el procesamiento (OpenAI + envíos) puede tomar varios segundos.
 */
export const inboundController = asyncHandler(async (req: Request, res: Response) => {
  const inbound = parseInboundWebhook(req.body);

  res.json({ success: true });

  // Fire-and-forget: no bloquear la respuesta del webhook
  void handleInbound(inbound).catch((err) => {
    console.error("[agent] handleInbound error:", err instanceof Error ? err.message : err);
  });
});
