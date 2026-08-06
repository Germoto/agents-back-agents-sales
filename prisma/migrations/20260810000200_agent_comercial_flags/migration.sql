-- Comportamiento configurable del agente en el rubro Comercial
ALTER TABLE "AgentConfig" ADD COLUMN "catalogMode" TEXT NOT NULL DEFAULT 'preguntar';
ALTER TABLE "AgentConfig" ADD COLUMN "keywordMode" TEXT NOT NULL DEFAULT 'detalle_y_preguntar';
ALTER TABLE "AgentConfig" ADD COLUMN "trackStock" BOOLEAN NOT NULL DEFAULT true;
