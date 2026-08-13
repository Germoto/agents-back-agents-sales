-- Multi-proveedor de IA por tenant: proveedor elegido (OPENAI | ANTHROPIC | GOOGLE)
-- + key de OpenAI opcional dedicada a transcripción de audios (Whisper).
ALTER TABLE "AgentConfig" ADD COLUMN IF NOT EXISTS "aiProvider" TEXT NOT NULL DEFAULT 'OPENAI';
ALTER TABLE "AgentConfig" ADD COLUMN IF NOT EXISTS "transcriptionApiKey" TEXT;
