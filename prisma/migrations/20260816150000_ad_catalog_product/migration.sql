-- Catálogo de anuncios: producto relacionado opcional (el lead del anuncio
-- entra con ese producto como interés).
ALTER TABLE "AdCatalogEntry" ADD COLUMN IF NOT EXISTS "productId" UUID;
ALTER TABLE "AdCatalogEntry" ADD CONSTRAINT "AdCatalogEntry_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
