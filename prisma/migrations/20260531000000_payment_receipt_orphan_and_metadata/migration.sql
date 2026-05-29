-- Migration: payment_receipt_orphan_and_metadata
-- Permite que un PaymentReceipt creado vía webhook quede "huérfano"
-- (sin customer ni product) y agrega metadatos provenientes del webhook
-- para que n8n pueda matchearlos posteriormente al cliente real.

-- 1. Hacer customerId / productId opcionales
ALTER TABLE "PaymentReceipt"
  ALTER COLUMN "customerId" DROP NOT NULL,
  ALTER COLUMN "productId"  DROP NOT NULL;

-- 2. Agregar metadatos del webhook
ALTER TABLE "PaymentReceipt"
  ADD COLUMN IF NOT EXISTS "payerName"        TEXT,
  ADD COLUMN IF NOT EXISTS "paymentSource"    TEXT,
  ADD COLUMN IF NOT EXISTS "occurredAt"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "validatedAt"      TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "validationNote"   TEXT;

-- 3. Índice para listar pendientes rápido por company
CREATE INDEX IF NOT EXISTS "PaymentReceipt_companyId_status_createdAt_idx"
  ON "PaymentReceipt"("companyId", "status", "createdAt");

-- 4. Cambiar onDelete CASCADE -> SET NULL para customer/product
--    (un receipt huérfano no debe eliminarse si el cliente/producto desaparece)
ALTER TABLE "PaymentReceipt" DROP CONSTRAINT IF EXISTS "PaymentReceipt_customerId_fkey";
ALTER TABLE "PaymentReceipt" DROP CONSTRAINT IF EXISTS "PaymentReceipt_productId_fkey";

ALTER TABLE "PaymentReceipt"
  ADD CONSTRAINT "PaymentReceipt_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL;

ALTER TABLE "PaymentReceipt"
  ADD CONSTRAINT "PaymentReceipt_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL;
