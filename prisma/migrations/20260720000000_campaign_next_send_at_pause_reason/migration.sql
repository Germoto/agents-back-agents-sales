-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "nextSendAt" TIMESTAMP(3),
ADD COLUMN     "pauseReason" TEXT;
