-- Registro en un solo paso + IA de prueba de la plataforma (todo aditivo, con defaults)
ALTER TABLE "PlatformConfig" ADD COLUMN "autoActivateRegistrations" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PlatformConfig" ADD COLUMN "autoActivateTrialDays" INTEGER NOT NULL DEFAULT 7;
ALTER TABLE "PlatformConfig" ADD COLUMN "trialAiEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PlatformConfig" ADD COLUMN "trialAiProvider" TEXT NOT NULL DEFAULT 'OPENAI';
ALTER TABLE "PlatformConfig" ADD COLUMN "trialAiModel" TEXT;
ALTER TABLE "PlatformConfig" ADD COLUMN "trialAiApiKey" TEXT;
ALTER TABLE "PlatformConfig" ADD COLUMN "trialAiMessageCap" INTEGER NOT NULL DEFAULT 200;

ALTER TABLE "AgentConfig" ADD COLUMN "aiKeySource" TEXT NOT NULL DEFAULT 'OWN';
ALTER TABLE "AgentConfig" ADD COLUMN "platformAiUsed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AgentConfig" ADD COLUMN "platformAiCap" INTEGER;

ALTER TABLE "WhatsappConfig" ADD COLUMN "provisionPending" BOOLEAN NOT NULL DEFAULT false;
