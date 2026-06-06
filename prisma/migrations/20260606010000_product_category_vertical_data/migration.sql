-- Vertical packs: categoría para agrupar el catálogo y datos estructurados por rubro.
ALTER TABLE "Product" ADD COLUMN "category" TEXT;
ALTER TABLE "Product" ADD COLUMN "verticalData" JSONB;
