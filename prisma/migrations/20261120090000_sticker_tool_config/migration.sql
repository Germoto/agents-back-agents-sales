-- Herramienta de stickers del agente (enviar_sticker): lista blanca de stickers de la
-- galería con su regla «cuándo». Aditiva: NULL = apagada, todo sigue como hoy.
ALTER TABLE "AgentConfig" ADD COLUMN IF NOT EXISTS "stickerToolConfig" JSONB;
