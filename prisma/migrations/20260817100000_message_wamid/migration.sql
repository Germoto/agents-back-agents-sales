-- wamid de WhatsApp por mensaje: llave de reacciones/citas. En USER llega en el
-- inbound; en ASSISTANT se aprende del webhook whatsapp_status (par id+wamid).
ALTER TABLE "ConversationMessage" ADD COLUMN IF NOT EXISTS "wamid" TEXT;
CREATE INDEX IF NOT EXISTS "ConversationMessage_wamid_idx" ON "ConversationMessage"("wamid");
