ALTER TABLE "PaymentConfig"
ADD COLUMN "notificationPhone" TEXT;

CREATE TABLE "PaymentMethod" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "paymentConfigId" UUID NOT NULL,
  "method" TEXT NOT NULL,
  "number" TEXT NOT NULL,
  "holder" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "PaymentMethod_paymentConfigId_sortOrder_idx" ON "PaymentMethod" ("paymentConfigId", "sortOrder");

ALTER TABLE "PaymentMethod"
ADD CONSTRAINT "PaymentMethod_paymentConfigId_fkey"
FOREIGN KEY ("paymentConfigId") REFERENCES "PaymentConfig"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
