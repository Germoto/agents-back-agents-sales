-- Tienda web "modo ventas": barra de anuncio, combos por volumen y ajustes de venta (aditivo).
ALTER TABLE "StorefrontConfig" ADD COLUMN IF NOT EXISTS "announcement" JSONB;
ALTER TABLE "StorefrontConfig" ADD COLUMN IF NOT EXISTS "volumePricing" JSONB;
ALTER TABLE "StorefrontConfig" ADD COLUMN IF NOT EXISTS "salesSettings" JSONB;
