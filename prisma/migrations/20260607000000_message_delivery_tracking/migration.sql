-- Tracking de entrega de mensajes del agente vía gateway WhatsApp (SMS Tools).
ALTER TABLE "ConversationMessage" ADD COLUMN "gatewayId" TEXT;
ALTER TABLE "ConversationMessage" ADD COLUMN "deliveryStatus" TEXT;
ALTER TABLE "ConversationMessage" ADD COLUMN "deliveryRetries" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "ConversationMessage_deliveryStatus_createdAt_idx" ON "ConversationMessage"("deliveryStatus", "createdAt");
