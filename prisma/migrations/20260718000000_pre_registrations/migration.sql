-- CreateEnum
CREATE TYPE "PreRegistrationStatus" AS ENUM ('EMAIL_PENDING', 'VERIFIED', 'CONVERTED', 'REJECTED');

-- CreateTable
CREATE TABLE "PreRegistration" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "status" "PreRegistrationStatus" NOT NULL DEFAULT 'EMAIL_PENDING',
    "planId" UUID,
    "companyName" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL DEFAULT '+51',
    "phone" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "vertical" "BusinessVertical" NOT NULL DEFAULT 'INFOPRODUCT',
    "emailCodeHash" TEXT,
    "emailCodeExpiresAt" TIMESTAMP(3),
    "emailCodeAttempts" INTEGER NOT NULL DEFAULT 0,
    "emailCodeSentAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "convertedAt" TIMESTAMP(3),
    "convertedCompanyId" UUID,
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "adminNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PreRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PreRegistration_status_createdAt_idx" ON "PreRegistration"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PreRegistration_email_idx" ON "PreRegistration"("email");

-- AddForeignKey
ALTER TABLE "PreRegistration" ADD CONSTRAINT "PreRegistration_planId_fkey" FOREIGN KEY ("planId") REFERENCES "PlatformPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
