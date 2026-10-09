-- Tienda web pública por tenant. Aditiva: enum nuevo, valor de enum nuevo y 2 tablas; sin backfill.
ALTER TYPE "PlanModule" ADD VALUE IF NOT EXISTS 'STOREFRONT';

DO $$ BEGIN
  CREATE TYPE "StoreOrderStatus" AS ENUM ('PENDIENTE', 'PAGADO', 'ENTREGADO', 'FALLIDO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "StorefrontConfig" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "title" TEXT,
  "tagline" TEXT,
  "accentColor" TEXT,
  "logoUrl" TEXT,
  "whatsappNumber" TEXT,
  "productIds" UUID[] DEFAULT ARRAY[]::UUID[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StorefrontConfig_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "StorefrontConfig_companyId_key" ON "StorefrontConfig"("companyId");
ALTER TABLE "StorefrontConfig" ADD CONSTRAINT "StorefrontConfig_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "StoreOrder" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "productName" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "phone" TEXT,
  "amount" DECIMAL(12,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'PEN',
  "status" "StoreOrderStatus" NOT NULL DEFAULT 'PENDIENTE',
  "mpPreferenceId" TEXT,
  "mpPaymentId" TEXT,
  "receiptId" UUID,
  "accessToken" TEXT NOT NULL,
  "deliveredAt" TIMESTAMP(3),
  "failureReason" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StoreOrder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "StoreOrder_receiptId_key" ON "StoreOrder"("receiptId");
CREATE INDEX IF NOT EXISTS "StoreOrder_companyId_createdAt_idx" ON "StoreOrder"("companyId", "createdAt");
CREATE INDEX IF NOT EXISTS "StoreOrder_companyId_status_idx" ON "StoreOrder"("companyId", "status");
ALTER TABLE "StoreOrder" ADD CONSTRAINT "StoreOrder_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoreOrder" ADD CONSTRAINT "StoreOrder_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
