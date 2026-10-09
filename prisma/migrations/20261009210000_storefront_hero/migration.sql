-- Tienda web: portada (carrusel), franja de confianza, FAQ generales, pie, precio anterior. Aditiva.
ALTER TABLE "StorefrontConfig" ADD COLUMN IF NOT EXISTS "heroSlides" JSONB;
ALTER TABLE "StorefrontConfig" ADD COLUMN IF NOT EXISTS "carouselAutoplay" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "StorefrontConfig" ADD COLUMN IF NOT EXISTS "carouselIntervalSec" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "StorefrontConfig" ADD COLUMN IF NOT EXISTS "showOldPrice" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "StorefrontConfig" ADD COLUMN IF NOT EXISTS "trustItems" JSONB;
ALTER TABLE "StorefrontConfig" ADD COLUMN IF NOT EXISTS "faqs" JSONB;
ALTER TABLE "StorefrontConfig" ADD COLUMN IF NOT EXISTS "footerTagline" TEXT;
