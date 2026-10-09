-- Tienda web: analítica ligera (eventos). Aditiva.
CREATE TABLE IF NOT EXISTS "StoreEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "productId" UUID,
  "orderId" UUID,
  "sessionId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StoreEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "StoreEvent_companyId_createdAt_idx" ON "StoreEvent"("companyId", "createdAt");
CREATE INDEX IF NOT EXISTS "StoreEvent_companyId_type_createdAt_idx" ON "StoreEvent"("companyId", "type", "createdAt");
DO $$ BEGIN
  ALTER TABLE "StoreEvent" ADD CONSTRAINT "StoreEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
