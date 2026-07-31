-- AlterTable: identidad de WhatsApp del lead (API lead de SMS Tools)
ALTER TABLE "Customer" ADD COLUMN "waIsLid" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Customer" ADD COLUMN "avatarUrl" TEXT;
