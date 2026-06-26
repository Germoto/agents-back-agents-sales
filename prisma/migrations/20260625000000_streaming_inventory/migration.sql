-- Streaming: modo de entrega por producto + inventario de credenciales.

-- CreateEnum
CREATE TYPE "DeliveryAssignmentMode" AS ENUM ('STATIC', 'POOL_AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "StreamingCredentialStatus" AS ENUM ('AVAILABLE', 'ASSIGNED', 'DOWN', 'DISABLED');

-- AlterTable (default STATIC = comportamiento actual; no afecta filas/rubros existentes)
ALTER TABLE "DigitalDelivery"
  ADD COLUMN "assignmentMode" "DeliveryAssignmentMode" NOT NULL DEFAULT 'STATIC';

-- CreateTable
CREATE TABLE "StreamingCredential" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "optionLabel" TEXT,
    "email" TEXT,
    "username" TEXT,
    "password" TEXT,
    "profileName" TEXT,
    "pin" TEXT,
    "extra" TEXT,
    "status" "StreamingCredentialStatus" NOT NULL DEFAULT 'AVAILABLE',
    "assignedCustomerId" UUID,
    "assignedConversationId" UUID,
    "assignedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StreamingCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StreamingCredential_companyId_productId_status_idx" ON "StreamingCredential"("companyId", "productId", "status");

-- AddForeignKey
ALTER TABLE "StreamingCredential" ADD CONSTRAINT "StreamingCredential_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
