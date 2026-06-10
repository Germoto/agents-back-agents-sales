-- Visibilidad de catálogo por producto (un secundario queda oculto del catálogo).
ALTER TABLE "Product"
  ADD COLUMN "showInCatalog" BOOLEAN NOT NULL DEFAULT true;
