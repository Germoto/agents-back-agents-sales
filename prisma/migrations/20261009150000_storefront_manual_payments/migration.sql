-- Tienda web: pago con Yape/Plin (comprobante subido). Aditiva, sin backfill.
ALTER TYPE "StoreOrderStatus" ADD VALUE IF NOT EXISTS 'EN_REVISION';
ALTER TABLE "StorefrontConfig" ADD COLUMN IF NOT EXISTS "manualPaymentsEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "StoreOrder" ADD COLUMN IF NOT EXISTS "paymentMethod" TEXT NOT NULL DEFAULT 'MERCADOPAGO';
ALTER TABLE "StoreOrder" ADD COLUMN IF NOT EXISTS "receiptMediaUrl" TEXT;
ALTER TABLE "StoreOrder" ADD COLUMN IF NOT EXISTS "payerName" TEXT;
ALTER TABLE "StoreOrder" ADD COLUMN IF NOT EXISTS "recheckAttempts" INTEGER NOT NULL DEFAULT 0;
