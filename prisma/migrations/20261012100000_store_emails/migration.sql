-- Tienda web: correos automáticos (recordatorios, bienvenida, campañas). Aditiva.
ALTER TABLE "StorefrontConfig" ADD COLUMN IF NOT EXISTS "emailReminders" JSONB;
CREATE TABLE IF NOT EXISTS "StoreEmail" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "customerId" UUID,
  "orderId" UUID,
  "campaignId" UUID,
  "kind" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "ctaLabel" TEXT,
  "ctaUrl" TEXT,
  "couponCode" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "sendAt" TIMESTAMP(3) NOT NULL,
  "sentAt" TIMESTAMP(3),
  "failureReason" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StoreEmail_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "StoreEmail_status_sendAt_idx" ON "StoreEmail"("status", "sendAt");
CREATE INDEX IF NOT EXISTS "StoreEmail_companyId_createdAt_idx" ON "StoreEmail"("companyId", "createdAt");
CREATE INDEX IF NOT EXISTS "StoreEmail_orderId_idx" ON "StoreEmail"("orderId");
CREATE INDEX IF NOT EXISTS "StoreEmail_campaignId_idx" ON "StoreEmail"("campaignId");
DO $$ BEGIN
  ALTER TABLE "StoreEmail" ADD CONSTRAINT "StoreEmail_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
