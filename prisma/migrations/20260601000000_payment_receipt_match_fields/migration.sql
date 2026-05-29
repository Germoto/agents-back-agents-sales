-- Migration: payment_receipt_match_fields
-- Extiende PaymentReceipt para soportar autovalidación n8n:
--   - amountPaid + currency (separados de amountExpected, que queda como mirror)
--   - payerPhone / operationCode / reference (datos extra del pagador si el origen los emite)
--   - productIds[] + orderId (soporte de carrito multi-producto)
--   - validationMode / matchScore / matchStrategy / matchedPayerNameInput / metadata (auditoría)
--   - claimedBy / claimedUntil (lock con TTL para evitar doble procesamiento)
--   - estado EN_REVISION en el enum

-- 1. Nuevo valor del enum (statement aparte por requerimiento de Postgres)
ALTER TYPE "ReceiptStatus" ADD VALUE IF NOT EXISTS 'EN_REVISION';

-- 2. Columnas nuevas
ALTER TABLE "PaymentReceipt"
  ADD COLUMN IF NOT EXISTS "amountPaid"            TEXT,
  ADD COLUMN IF NOT EXISTS "currency"              TEXT NOT NULL DEFAULT 'PEN',
  ADD COLUMN IF NOT EXISTS "payerPhone"            TEXT,
  ADD COLUMN IF NOT EXISTS "operationCode"         TEXT,
  ADD COLUMN IF NOT EXISTS "reference"             TEXT,
  ADD COLUMN IF NOT EXISTS "productIds"            UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "orderId"               TEXT,
  ADD COLUMN IF NOT EXISTS "validationMode"        TEXT,
  ADD COLUMN IF NOT EXISTS "matchScore"            INTEGER,
  ADD COLUMN IF NOT EXISTS "matchStrategy"         TEXT,
  ADD COLUMN IF NOT EXISTS "matchedPayerNameInput" TEXT,
  ADD COLUMN IF NOT EXISTS "metadata"              JSONB,
  ADD COLUMN IF NOT EXISTS "claimedBy"             TEXT,
  ADD COLUMN IF NOT EXISTS "claimedUntil"          TIMESTAMP(3);

-- 3. Backfill amountPaid <- amountExpected para registros existentes
UPDATE "PaymentReceipt"
   SET "amountPaid" = "amountExpected"
 WHERE "amountPaid" IS NULL;

-- 4. Índices para filtros y match
CREATE INDEX IF NOT EXISTS "PaymentReceipt_companyId_amountPaid_idx"
  ON "PaymentReceipt"("companyId", "amountPaid");

CREATE INDEX IF NOT EXISTS "PaymentReceipt_companyId_occurredAt_idx"
  ON "PaymentReceipt"("companyId", "occurredAt");
