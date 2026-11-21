-- Leads de regalo del mes en curso (superadmin). Aditivo: 0 / null = sin regalo.
ALTER TABLE "CompanySubscription" ADD COLUMN IF NOT EXISTS "bonusLeads" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CompanySubscription" ADD COLUMN IF NOT EXISTS "bonusLeadsUntil" TIMESTAMP(3);
