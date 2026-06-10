-- Flag por archivo: incluir en la presentación/info inicial del producto (envío bulk).
-- Aditivo: las filas existentes quedan en true (preserva el comportamiento actual).
ALTER TABLE "ProductFile" ADD COLUMN "showInPresentation" BOOLEAN NOT NULL DEFAULT true;
