-- Cliente que pidió no ser contactado (opt-out de WhatsApp) y chats fijados en el panel.
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "optOutAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "Customer_companyId_optOutAt_idx" ON "Customer"("companyId", "optOutAt");

ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "pinnedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "Conversation_companyId_pinnedAt_idx" ON "Conversation"("companyId", "pinnedAt");
