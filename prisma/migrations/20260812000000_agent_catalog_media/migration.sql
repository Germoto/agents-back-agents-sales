-- Carta/catálogo multimedia configurable: cómo presenta el agente el catálogo
-- (solo texto, solo carta PDF/imagen, o ambos) y el archivo de la carta.
ALTER TABLE "AgentConfig" ADD COLUMN IF NOT EXISTS "catalogMediaMode" TEXT NOT NULL DEFAULT 'text';
ALTER TABLE "AgentConfig" ADD COLUMN IF NOT EXISTS "catalogMediaUrl" TEXT;
ALTER TABLE "AgentConfig" ADD COLUMN IF NOT EXISTS "catalogMediaType" TEXT;
ALTER TABLE "AgentConfig" ADD COLUMN IF NOT EXISTS "catalogMediaFileName" TEXT;
