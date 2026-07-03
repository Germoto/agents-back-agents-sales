-- Monetización SaaS: paquetes (PlatformPlan), suscripciones de tenants
-- (CompanySubscription), vales (Voucher) y créditos (CompanyWallet +
-- CreditTransaction). Solo tablas/enums nuevos: cero impacto en datos existentes.

-- CreateEnum
CREATE TYPE "PlanModule" AS ENUM ('CAMPAIGNS', 'CRM', 'FLOWS', 'QUICK_REPLIES', 'FUNNEL', 'META_PROVIDER');

-- CreateEnum
CREATE TYPE "VoucherType" AS ENUM ('PLAN', 'CREDIT');

-- CreateEnum
CREATE TYPE "CreditTxType" AS ENUM ('VOUCHER', 'ADMIN_ADJUST', 'LEAD_CHARGE');

-- CreateTable
CREATE TABLE "PlatformPlan" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceUsd" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "pricePen" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "monthlyLeadLimit" INTEGER,
    "extraLeadPricePen" DECIMAL(10,2),
    "verticals" "BusinessVertical"[] DEFAULT ARRAY['INFOPRODUCT']::"BusinessVertical"[],
    "modules" "PlanModule"[] DEFAULT ARRAY[]::"PlanModule"[],
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "isHighlighted" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanySubscription" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "months" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT NOT NULL DEFAULT 'SUPERADMIN',
    "voucherId" UUID,
    "canceledAt" TIMESTAMP(3),
    "lastNoticeAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanySubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyWallet" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "balancePen" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditTransaction" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "type" "CreditTxType" NOT NULL,
    "amountPen" DECIMAL(12,2) NOT NULL,
    "balanceAfterPen" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "voucherId" UUID,
    "customerPhone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Voucher" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "VoucherType" NOT NULL DEFAULT 'PLAN',
    "planId" UUID,
    "months" INTEGER,
    "creditAmountPen" DECIMAL(12,2),
    "redeemedAt" TIMESTAMP(3),
    "redeemedByCompanyId" UUID,
    "redeemedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Voucher_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompanySubscription_companyId_key" ON "CompanySubscription"("companyId");

-- CreateIndex
CREATE INDEX "CompanySubscription_expiresAt_idx" ON "CompanySubscription"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyWallet_companyId_key" ON "CompanyWallet"("companyId");

-- CreateIndex
CREATE INDEX "CreditTransaction_companyId_createdAt_idx" ON "CreditTransaction"("companyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Voucher_code_key" ON "Voucher"("code");

-- CreateIndex
CREATE INDEX "Voucher_type_redeemedAt_idx" ON "Voucher"("type", "redeemedAt");

-- CreateIndex
CREATE INDEX "Voucher_planId_idx" ON "Voucher"("planId");

-- AddForeignKey
ALTER TABLE "CompanySubscription" ADD CONSTRAINT "CompanySubscription_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanySubscription" ADD CONSTRAINT "CompanySubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "PlatformPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyWallet" ADD CONSTRAINT "CompanyWallet_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_planId_fkey" FOREIGN KEY ("planId") REFERENCES "PlatformPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_redeemedByCompanyId_fkey" FOREIGN KEY ("redeemedByCompanyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
