-- Atribución de anuncios Meta CTWA en el lead (primera gana; ctwaClid íntegro
-- para la futura Conversions API) + catálogo de descripciones por anuncio.
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "adSourceId" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "adTitle" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "ctwaClid" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "adSourceUrl" TEXT;
CREATE INDEX IF NOT EXISTS "Customer_companyId_adSourceId_idx" ON "Customer"("companyId", "adSourceId");

CREATE TABLE IF NOT EXISTS "AdCatalogEntry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "matchers" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdCatalogEntry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AdCatalogEntry_companyId_idx" ON "AdCatalogEntry"("companyId");
ALTER TABLE "AdCatalogEntry" ADD CONSTRAINT "AdCatalogEntry_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
