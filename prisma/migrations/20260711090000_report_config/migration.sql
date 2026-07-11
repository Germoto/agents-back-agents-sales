-- Reportes automáticos del dashboard (Excel por email/WhatsApp): config por tenant.
-- Solo tabla nueva: cero impacto en datos existentes.

-- CreateTable
CREATE TABLE "ReportConfig" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "email" TEXT,
    "waPhone" TEXT,
    "dailyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "weeklyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "monthlyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "sendHour" INTEGER NOT NULL DEFAULT 8,
    "lastDailyKey" TEXT,
    "lastWeeklyKey" TEXT,
    "lastMonthlyKey" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReportConfig_companyId_key" ON "ReportConfig"("companyId");

-- AddForeignKey
ALTER TABLE "ReportConfig" ADD CONSTRAINT "ReportConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
