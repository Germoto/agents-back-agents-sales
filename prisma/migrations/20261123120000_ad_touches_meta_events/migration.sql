-- Trackeo de anuncios sin huecos. Todo ADITIVO: tablas y columnas nuevas; nada se
-- borra ni se renombra. Las columnas de anuncio que ya tenía Customer quedan como el
-- PRIMER anuncio; las nuevas guardan el ÚLTIMO clic.

-- 1) Cada clic de anuncio del cliente.
CREATE TABLE IF NOT EXISTS "AdTouch" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "conversationId" UUID,
    "adSourceId" TEXT NOT NULL,
    "adTitle" TEXT,
    "ctwaClid" TEXT,
    "adSourceUrl" TEXT,
    "sourceType" TEXT,
    "messageId" TEXT,
    "entryId" UUID,
    "flowConsumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdTouch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AdTouch_companyId_messageId_key" ON "AdTouch"("companyId", "messageId");
CREATE INDEX IF NOT EXISTS "AdTouch_customerId_createdAt_idx" ON "AdTouch"("customerId", "createdAt");
CREATE INDEX IF NOT EXISTS "AdTouch_companyId_adSourceId_createdAt_idx" ON "AdTouch"("companyId", "adSourceId", "createdAt");
DO $$ BEGIN
  ALTER TABLE "AdTouch" ADD CONSTRAINT "AdTouch_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2) Último clic en la ficha del cliente.
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "lastAdSourceId" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "lastAdTitle" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "lastCtwaClid" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "lastAdAt" TIMESTAMP(3);

-- 3) Cola de compras reportadas a Meta (control de duplicados y reintentos).
CREATE TABLE IF NOT EXISTS "MetaConversionEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "eventKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "receiptId" UUID,
    "orderId" TEXT,
    "customerId" UUID,
    "adSourceId" TEXT,
    "adTitle" TEXT,
    "hasClick" BOOLEAN NOT NULL DEFAULT false,
    "value" DECIMAL(12,2),
    "currency" TEXT,
    "eventTime" TIMESTAMP(3) NOT NULL,
    "payload" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MetaConversionEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "MetaConversionEvent_companyId_eventKey_key" ON "MetaConversionEvent"("companyId", "eventKey");
CREATE INDEX IF NOT EXISTS "MetaConversionEvent_companyId_createdAt_idx" ON "MetaConversionEvent"("companyId", "createdAt");
CREATE INDEX IF NOT EXISTS "MetaConversionEvent_status_nextAttemptAt_idx" ON "MetaConversionEvent"("status", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "MetaConversionEvent_companyId_customerId_createdAt_idx" ON "MetaConversionEvent"("companyId", "customerId", "createdAt");
DO $$ BEGIN
  ALTER TABLE "MetaConversionEvent" ADD CONSTRAINT "MetaConversionEvent_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 4) Interruptor: reportar también ventas sin clic de anuncio (apagado por defecto).
ALTER TABLE "MetaCapiConfig" ADD COLUMN IF NOT EXISTS "reportWithoutClick" BOOLEAN NOT NULL DEFAULT false;

-- 5) Anuncio vigente al momento de la venta.
ALTER TABLE "PaymentReceipt" ADD COLUMN IF NOT EXISTS "adSourceId" TEXT;
ALTER TABLE "PaymentReceipt" ADD COLUMN IF NOT EXISTS "adTitle" TEXT;

-- 6) Relleno inicial (solo inserta / completa vacíos):
--    a) un toque por cada cliente que ya tenía anuncio (el primero), ya consumido
--       para que los flujos «lead de anuncio» no se disparen de nuevo;
INSERT INTO "AdTouch" ("companyId", "customerId", "adSourceId", "adTitle", "ctwaClid", "adSourceUrl", "flowConsumedAt", "createdAt")
SELECT c."companyId", c."id", c."adSourceId", c."adTitle", c."ctwaClid", c."adSourceUrl", CURRENT_TIMESTAMP, c."createdAt"
FROM "Customer" c
WHERE c."adSourceId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "AdTouch" t WHERE t."customerId" = c."id");
--    b) último clic = primero, donde aún no hay último;
UPDATE "Customer"
SET "lastAdSourceId" = "adSourceId", "lastAdTitle" = "adTitle", "lastCtwaClid" = "ctwaClid", "lastAdAt" = "createdAt"
WHERE "adSourceId" IS NOT NULL AND "lastAdSourceId" IS NULL;
--    c) ventas ya aprobadas: quedan con el anuncio que tenía el cliente (lo mismo
--       que mostraba el panel hasta hoy).
UPDATE "PaymentReceipt" r
SET "adSourceId" = c."adSourceId", "adTitle" = c."adTitle"
FROM "Customer" c
WHERE r."customerId" = c."id" AND r."status" = 'APROBADO'
  AND r."adSourceId" IS NULL AND c."adSourceId" IS NOT NULL;
