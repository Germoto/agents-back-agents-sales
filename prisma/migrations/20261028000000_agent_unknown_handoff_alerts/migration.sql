-- Derivación real «si no sabe responder» + aviso de mensajes en chats en atención humana.
ALTER TABLE "AgentConfig" ADD COLUMN "unknownHandoff" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AgentConfig" ADD COLUMN "humanChatAlerts" BOOLEAN NOT NULL DEFAULT true;
