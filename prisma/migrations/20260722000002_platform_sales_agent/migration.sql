-- AlterTable: agente de ventas de la plataforma (puntero al tenant oculto + conocimiento)
ALTER TABLE "PlatformConfig" ADD COLUMN "salesAgentCompanyId" UUID;
ALTER TABLE "PlatformConfig" ADD COLUMN "salesAgentKnowledge" JSONB;
