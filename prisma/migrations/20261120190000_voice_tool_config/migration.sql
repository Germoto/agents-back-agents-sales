-- Notas de voz del agente (enviar_nota_de_voz). Aditivo: null = apagada.
ALTER TABLE "AgentConfig" ADD COLUMN IF NOT EXISTS "voiceToolConfig" JSONB;
ALTER TABLE "AgentConfig" ADD COLUMN IF NOT EXISTS "voiceApiKey" TEXT;
