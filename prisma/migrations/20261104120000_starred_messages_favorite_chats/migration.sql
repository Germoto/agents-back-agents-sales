-- Mensajes destacados por chat y chats favoritos (aditivo)
ALTER TABLE "ConversationMessage" ADD COLUMN "starredAt" TIMESTAMP(3);
ALTER TABLE "Conversation" ADD COLUMN "favoriteAt" TIMESTAMP(3);
CREATE INDEX "ConversationMessage_conversationId_starredAt_idx" ON "ConversationMessage"("conversationId", "starredAt");
CREATE INDEX "Conversation_companyId_favoriteAt_idx" ON "Conversation"("companyId", "favoriteAt");
