-- Tienda web: carrito multi-producto (snapshot de ítems). Aditiva, sin backfill.
ALTER TABLE "StoreOrder" ADD COLUMN IF NOT EXISTS "items" JSONB;
ALTER TABLE "StoreOrder" ADD COLUMN IF NOT EXISTS "productIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];
