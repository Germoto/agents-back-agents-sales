-- Cobros de plataforma con Mercado Pago (autoservicio de plan/créditos)

-- AlterEnum
ALTER TYPE "CreditTxType" ADD VALUE IF NOT EXISTS 'MP_TOPUP';

-- AlterTable
ALTER TABLE "PlatformConfig" ADD COLUMN "mpBillingEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PlatformConfig" ADD COLUMN "mpBillingAccessToken" TEXT;

-- CreateTable
CREATE TABLE "PlatformPayment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "planId" UUID,
    "months" INTEGER,
    "amountPen" DECIMAL(10,2) NOT NULL,
    "creditAmountPen" DECIMAL(10,2),
    "mpPreferenceId" TEXT,
    "mpPaymentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "PlatformPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformPayment_mpPaymentId_key" ON "PlatformPayment"("mpPaymentId");
CREATE INDEX "PlatformPayment_companyId_createdAt_idx" ON "PlatformPayment"("companyId", "createdAt");

-- AddForeignKey
ALTER TABLE "PlatformPayment" ADD CONSTRAINT "PlatformPayment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
