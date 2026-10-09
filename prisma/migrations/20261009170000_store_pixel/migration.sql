-- Píxel de Meta en la tienda web. Aditiva, default false = sin cambio.
ALTER TABLE "MetaCapiConfig" ADD COLUMN IF NOT EXISTS "pixelEnabled" BOOLEAN NOT NULL DEFAULT false;
