-- Tienda web para productos físicos. Aditiva, sin defaults ni backfill: todo NULL = como hoy.
-- Única relajación: el correo del pedido de tienda deja de ser obligatorio (la tienda
-- física pide WhatsApp; la digital lo sigue exigiendo en su validación).
ALTER TABLE "StoreOrder" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "StoreOrder" ADD COLUMN IF NOT EXISTS "orderTotal" DECIMAL(12,2);
ALTER TABLE "StoreOrder" ADD COLUMN IF NOT EXISTS "shipping" JSONB;
ALTER TABLE "StoreOrder" ADD COLUMN IF NOT EXISTS "orderId" UUID;
CREATE UNIQUE INDEX IF NOT EXISTS "StoreOrder_orderId_key" ON "StoreOrder"("orderId");
DO $$ BEGIN
  ALTER TABLE "StoreOrder" ADD CONSTRAINT "StoreOrder_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "source" TEXT;

ALTER TABLE "StorefrontConfig" ADD COLUMN IF NOT EXISTS "physical" JSONB;
