-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "messageGapEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "messageGapSeconds" INTEGER NOT NULL DEFAULT 3;
