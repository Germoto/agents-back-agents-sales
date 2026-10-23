-- Acciones CRM por anuncio del catálogo: etiquetas y columna al llegar el lead (sin FK, como en productos).
ALTER TABLE "AdCatalogEntry" ADD COLUMN IF NOT EXISTS "tagIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];
ALTER TABLE "AdCatalogEntry" ADD COLUMN IF NOT EXISTS "crmId" UUID;
ALTER TABLE "AdCatalogEntry" ADD COLUMN IF NOT EXISTS "crmColumnId" UUID;
