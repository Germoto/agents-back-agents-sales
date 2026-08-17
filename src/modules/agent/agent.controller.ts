import { Request, Response } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { parseInboundWebhook, parseStatusWebhook, parseTypingWebhook } from "../../lib/smstools-client";
import { handleInbound, handleTypingEvent } from "./agent.service";
import { applyDeliveryStatus } from "./conversation.service";

/**
 * Webhook inbound de WhatsApp (SMS Tools). Responde 200 de inmediato y procesa
 * el turno del agente en background: SMS Tools reintenta si la respuesta tarda,
 * y el procesamiento (OpenAI + envíos) puede tomar varios segundos.
 */
export const inboundController = asyncHandler(async (req: Request, res: Response) => {
  // Evento efímero "escribiendo/grabando" (type: "whatsapp_typing"): se reenvía
  // al panel por socket y NO se persiste ni corre el agente.
  const typing = parseTypingWebhook(req.body);
  if (typing) {
    res.json({ success: true });
    void handleTypingEvent(typing).catch((err) => {
      console.warn("[agent] handleTypingEvent error:", err instanceof Error ? err.message : err);
    });
    return;
  }

  // Evento de ESTADO de entrega (type: "whatsapp_status"): actualiza los checks
  // del mensaje (correlación por messageId del envío o wamid) y no corre el agente.
  const status = parseStatusWebhook(req.body);
  if (status) {
    res.json({ success: true });
    void applyDeliveryStatus([status.messageId, status.wamid], status.status).catch((err) => {
      console.warn("[agent] applyDeliveryStatus error:", err instanceof Error ? err.message : err);
    });
    return;
  }

  const inbound = parseInboundWebhook(req.body);

  res.json({ success: true });

  // Fire-and-forget: no bloquear la respuesta del webhook
  void handleInbound(inbound).catch((err) => {
    console.error("[agent] handleInbound error:", err instanceof Error ? err.message : err);
  });
});
