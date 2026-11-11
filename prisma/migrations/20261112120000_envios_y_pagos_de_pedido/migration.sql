-- Envíos del rubro comercial: agencias de courier, pedido con datos de envío y dinero,
-- pagos por pedido (adelanto y saldo). Aditiva, sin defaults ni backfill: todo NULL = como hoy.
-- El valor nuevo del enum NO se usa en esta misma migración.
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'LISTO_PARA_RECOGER';

ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "shippingConfig" JSONB;

ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "deliveryType" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "courier" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "agencyId" UUID;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "agencyName" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "agencyAddress" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "recipientDocument" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "recipientPhone" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "subtotalAmount" DECIMAL(12,2);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "shippingAmount" DECIMAL(12,2);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "totalAmount" DECIMAL(12,2);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "advanceAmount" DECIMAL(12,2);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "paidAmount" DECIMAL(12,2);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "trackingCode" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "pickupKey" TEXT;

CREATE TABLE IF NOT EXISTS "OrderPayment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "kind" TEXT NOT NULL,
    "method" TEXT,
    "source" TEXT NOT NULL,
    "receiptId" UUID,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderPayment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "OrderPayment_receiptId_key" ON "OrderPayment"("receiptId");
CREATE INDEX IF NOT EXISTS "OrderPayment_orderId_idx" ON "OrderPayment"("orderId");
CREATE INDEX IF NOT EXISTS "OrderPayment_companyId_createdAt_idx" ON "OrderPayment"("companyId", "createdAt");
DO $$ BEGIN
  ALTER TABLE "OrderPayment" ADD CONSTRAINT "OrderPayment_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "CourierAgency" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "courier" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "department" TEXT,
    "province" TEXT,
    "district" TEXT,
    "place" TEXT,
    "address" TEXT,
    "schedule" TEXT,
    "phone" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "ubigeo" TEXT,
    "acceptsDestination" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "searchText" TEXT NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourierAgency_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "CourierAgency_courier_externalId_key" ON "CourierAgency"("courier", "externalId");
CREATE INDEX IF NOT EXISTS "CourierAgency_courier_isActive_idx" ON "CourierAgency"("courier", "isActive");
