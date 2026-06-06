-- Modo de respuesta del agente (OPEN | ALLOWLIST) + lista de números de prueba.
ALTER TABLE "AgentConfig" ADD COLUMN "replyMode" TEXT NOT NULL DEFAULT 'OPEN';
ALTER TABLE "AgentConfig" ADD COLUMN "testNumbers" JSONB;
