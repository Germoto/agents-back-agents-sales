-- Tienda web: cupones de descuento. Aditiva.
CREATE TABLE IF NOT EXISTS "Coupon" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'PERCENT',
  "value" DECIMAL(12,2) NOT NULL,
  "productIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "maxUses" INTEGER,
  "uses" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Coupon_companyId_code_key" ON "Coupon"("companyId", "code");
CREATE INDEX IF NOT EXISTS "Coupon_companyId_active_idx" ON "Coupon"("companyId", "active");
DO $$ BEGIN
  ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
