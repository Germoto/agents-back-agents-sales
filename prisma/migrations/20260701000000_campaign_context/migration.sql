-- Producto en foco + etiquetas de la campaña (contexto para el agente / segmentación).
ALTER TABLE "Campaign" ADD COLUMN "contextProductId" UUID;
ALTER TABLE "Campaign" ADD COLUMN "contextTagIds" TEXT[] NOT NULL DEFAULT '{}';
