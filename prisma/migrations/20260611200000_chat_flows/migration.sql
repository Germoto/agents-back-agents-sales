-- Flujos guiados de chatbot (alternativa al agente IA) + modo de operación del bot.

-- Modo de operación del bot por empresa: "AI" | "FLOW".
ALTER TABLE "Company" ADD COLUMN "botMode" TEXT NOT NULL DEFAULT 'AI';

-- Timeout de bloques de flujo (persistente, lo procesa el scheduler worker).
ALTER TYPE "ScheduledMessageType" ADD VALUE IF NOT EXISTS 'FLOW_TIMEOUT';

CREATE TABLE "ChatFlow" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "trigger" JSONB NOT NULL DEFAULT '{}',
    "nodes" JSONB NOT NULL DEFAULT '[]',
    "edges" JSONB NOT NULL DEFAULT '[]',
    "viewport" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatFlow_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatFlow_companyId_name_key" ON "ChatFlow"("companyId", "name");
CREATE INDEX "ChatFlow_companyId_isActive_idx" ON "ChatFlow"("companyId", "isActive");

ALTER TABLE "ChatFlow" ADD CONSTRAINT "ChatFlow_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
