-- Checks de entrega (delivered/read por webhook whatsapp_status), reacciones
-- (emoji anclado por target_wamid) y respuestas citando (quoted_wamid + preview).
ALTER TABLE "ConversationMessage" ADD COLUMN IF NOT EXISTS "reaction" TEXT;
ALTER TABLE "ConversationMessage" ADD COLUMN IF NOT EXISTS "quotedWamid" TEXT;
ALTER TABLE "ConversationMessage" ADD COLUMN IF NOT EXISTS "quotedPreview" TEXT;
CREATE INDEX IF NOT EXISTS "ConversationMessage_gatewayId_idx" ON "ConversationMessage"("gatewayId");
