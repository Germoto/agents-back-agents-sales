-- Tienda web: personalización por producto (portada, categoría, descripción corta, orden). Aditiva.
ALTER TABLE "StorefrontConfig" ADD COLUMN IF NOT EXISTS "productOverrides" JSONB;
