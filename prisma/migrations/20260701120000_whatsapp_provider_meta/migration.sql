-- Proveedor dual de WhatsApp: SMS Tools (default, filas existentes intactas) + Meta Cloud API.
-- Migración ADITIVA: no modifica datos existentes.

-- CreateEnum
CREATE TYPE "WhatsappProviderType" AS ENUM ('SMSTOOLS', 'META');

-- AlterTable
ALTER TABLE "WhatsappConfig"
  ADD COLUMN "provider" "WhatsappProviderType" NOT NULL DEFAULT 'SMSTOOLS',
  ADD COLUMN "metaAccessToken" TEXT,
  ADD COLUMN "metaPhoneNumberId" TEXT,
  ADD COLUMN "metaWabaId" TEXT,
  ADD COLUMN "metaDisplayPhone" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappConfig_metaPhoneNumberId_key" ON "WhatsappConfig"("metaPhoneNumberId");
