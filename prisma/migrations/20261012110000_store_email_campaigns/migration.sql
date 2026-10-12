-- Tienda web: campañas de correo (promociones). Aditiva.
CREATE TABLE IF NOT EXISTS "StoreEmailCampaign" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "imageUrl" TEXT,
  "ctaLabel" TEXT,
  "ctaUrl" TEXT,
  "couponCode" TEXT,
  "audience" JSONB NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "scheduledAt" TIMESTAMP(3),
  "totalCount" INTEGER NOT NULL DEFAULT 0,
  "sentCount" INTEGER NOT NULL DEFAULT 0,
  "failedCount" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StoreEmailCampaign_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "StoreEmailCampaign_companyId_createdAt_idx" ON "StoreEmailCampaign"("companyId", "createdAt");
CREATE INDEX IF NOT EXISTS "StoreEmailCampaign_status_scheduledAt_idx" ON "StoreEmailCampaign"("status", "scheduledAt");
DO $$ BEGIN
  ALTER TABLE "StoreEmailCampaign" ADD CONSTRAINT "StoreEmailCampaign_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE "StoreEvent" ADD COLUMN IF NOT EXISTS "campaignId" UUID;
CREATE INDEX IF NOT EXISTS "StoreEvent_campaignId_idx" ON "StoreEvent"("campaignId");
