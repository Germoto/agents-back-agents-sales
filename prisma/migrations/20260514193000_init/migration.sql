CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE "UserRole" AS ENUM ('SUPERADMIN', 'ADMIN', 'OPERATOR');
CREATE TYPE "ProductType" AS ENUM ('DIGITAL', 'PHYSICAL');
CREATE TYPE "PaymentMode" AS ENUM ('BEFORE_DELIVERY', 'CASH_ON_DELIVERY', 'MANUAL');
CREATE TYPE "ConversationRole" AS ENUM ('USER', 'ASSISTANT', 'ADMIN', 'SYSTEM');
CREATE TYPE "OrderStatus" AS ENUM ('PEDIDO_REGISTRADO', 'EN_COORDINACION', 'DESPACHADO', 'CANCELADO');
CREATE TYPE "DigitalSaleStatus" AS ENUM ('ESPERANDO_PAGO', 'COMPROBANTE_RECIBIDO', 'PAGO_RECHAZADO', 'ENTREGADO', 'CANCELADO');
CREATE TYPE "ReceiptStatus" AS ENUM ('PENDIENTE', 'APROBADO', 'RECHAZADO');

CREATE TABLE "Company" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL UNIQUE,
  "adminPhone" TEXT NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'America/Lima',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "User" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "phone" TEXT NOT NULL UNIQUE,
  "passwordHash" TEXT NOT NULL,
  "role" "UserRole" NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "AgentConfig" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL UNIQUE,
  "openaiModel" TEXT NOT NULL DEFAULT 'gpt-4o-mini',
  "temperature" DECIMAL(4,2) NOT NULL DEFAULT 0.25,
  "basePrompt" TEXT NOT NULL,
  "salesStyle" TEXT NOT NULL,
  "rules" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "WhatsappConfig" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL UNIQUE,
  "apiUrl" TEXT NOT NULL,
  "secret" TEXT NOT NULL,
  "account" TEXT NOT NULL UNIQUE,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "PaymentConfig" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL UNIQUE,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "method" TEXT NOT NULL,
  "number" TEXT NOT NULL,
  "holder" TEXT NOT NULL,
  "paymentMode" "PaymentMode" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "Product" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "slug" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "productType" "ProductType" NOT NULL,
  "name" TEXT NOT NULL,
  "price" TEXT NOT NULL,
  "regularPrice" TEXT,
  "stock" INTEGER,
  "shortDescription" TEXT NOT NULL,
  "fullDescription" TEXT NOT NULL,
  "deliveryMethod" TEXT,
  "support" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Product_companyId_slug_key" UNIQUE ("companyId", "slug")
);

CREATE TABLE "ProductAlias" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "productId" UUID NOT NULL,
  "value" TEXT NOT NULL
);

CREATE TABLE "ProductBenefit" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "productId" UUID NOT NULL,
  "value" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL
);

CREATE TABLE "ProductInclude" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "productId" UUID NOT NULL,
  "value" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL
);

CREATE TABLE "ProductBonus" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "productId" UUID NOT NULL,
  "value" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL
);

CREATE TABLE "ProductFaq" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "productId" UUID NOT NULL,
  "question" TEXT NOT NULL,
  "answer" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL
);

CREATE TABLE "ProductObjection" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "productId" UUID NOT NULL,
  "question" TEXT NOT NULL,
  "answer" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL
);

CREATE TABLE "ProductMedia" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "productId" UUID NOT NULL UNIQUE,
  "imageUrl" TEXT,
  "pdfUrl" TEXT,
  "videoUrl" TEXT
);

CREATE TABLE "DigitalDelivery" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "productId" UUID NOT NULL UNIQUE,
  "link" TEXT NOT NULL,
  "instructions" TEXT NOT NULL
);

CREATE TABLE "PhysicalDelivery" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "productId" UUID NOT NULL UNIQUE,
  "requiresAddress" BOOLEAN NOT NULL DEFAULT true,
  "deliveryCost" TEXT,
  "deliveryTime" TEXT,
  "pickupAvailable" BOOLEAN NOT NULL DEFAULT false,
  "deliveryAreas" JSONB NOT NULL
);

CREATE TABLE "ProductVariant" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "productId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "options" JSONB NOT NULL,
  "sortOrder" INTEGER NOT NULL
);

CREATE TABLE "Customer" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "phone" TEXT NOT NULL,
  "name" TEXT,
  "email" TEXT,
  "status" TEXT NOT NULL,
  "selectedProductId" UUID,
  "lastInteractionAt" TIMESTAMP(3) NOT NULL,
  "metadata" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Customer_companyId_phone_key" UNIQUE ("companyId", "phone")
);

CREATE TABLE "ConversationMessage" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "productId" UUID,
  "role" "ConversationRole" NOT NULL,
  "message" TEXT,
  "mediaUrl" TEXT,
  "rawPayload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "Order" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "orderCode" TEXT NOT NULL UNIQUE,
  "quantity" INTEGER NOT NULL,
  "customerName" TEXT NOT NULL,
  "address" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "notes" TEXT,
  "status" "OrderStatus" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "DigitalSale" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "amountExpected" TEXT NOT NULL,
  "status" "DigitalSaleStatus" NOT NULL,
  "deliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "PaymentReceipt" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "digitalSaleId" UUID,
  "mediaUrl" TEXT,
  "amountExpected" TEXT NOT NULL,
  "status" "ReceiptStatus" NOT NULL,
  "rejectionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "User_companyId_idx" ON "User" ("companyId");
CREATE INDEX "Product_companyId_active_sortOrder_idx" ON "Product" ("companyId", "active", "sortOrder");
CREATE INDEX "Customer_companyId_lastInteractionAt_idx" ON "Customer" ("companyId", "lastInteractionAt");
CREATE INDEX "ConversationMessage_companyId_customerId_createdAt_idx" ON "ConversationMessage" ("companyId", "customerId", "createdAt");
CREATE INDEX "Order_companyId_createdAt_idx" ON "Order" ("companyId", "createdAt");
CREATE INDEX "DigitalSale_companyId_createdAt_idx" ON "DigitalSale" ("companyId", "createdAt");
CREATE INDEX "PaymentReceipt_companyId_createdAt_idx" ON "PaymentReceipt" ("companyId", "createdAt");

ALTER TABLE "User" ADD CONSTRAINT "User_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentConfig" ADD CONSTRAINT "AgentConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WhatsappConfig" ADD CONSTRAINT "WhatsappConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentConfig" ADD CONSTRAINT "PaymentConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Product" ADD CONSTRAINT "Product_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductAlias" ADD CONSTRAINT "ProductAlias_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductBenefit" ADD CONSTRAINT "ProductBenefit_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductInclude" ADD CONSTRAINT "ProductInclude_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductBonus" ADD CONSTRAINT "ProductBonus_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductFaq" ADD CONSTRAINT "ProductFaq_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductObjection" ADD CONSTRAINT "ProductObjection_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductMedia" ADD CONSTRAINT "ProductMedia_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DigitalDelivery" ADD CONSTRAINT "DigitalDelivery_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PhysicalDelivery" ADD CONSTRAINT "PhysicalDelivery_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_selectedProductId_fkey" FOREIGN KEY ("selectedProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ConversationMessage" ADD CONSTRAINT "ConversationMessage_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationMessage" ADD CONSTRAINT "ConversationMessage_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationMessage" ADD CONSTRAINT "ConversationMessage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DigitalSale" ADD CONSTRAINT "DigitalSale_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DigitalSale" ADD CONSTRAINT "DigitalSale_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DigitalSale" ADD CONSTRAINT "DigitalSale_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentReceipt" ADD CONSTRAINT "PaymentReceipt_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentReceipt" ADD CONSTRAINT "PaymentReceipt_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentReceipt" ADD CONSTRAINT "PaymentReceipt_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentReceipt" ADD CONSTRAINT "PaymentReceipt_digitalSaleId_fkey" FOREIGN KEY ("digitalSaleId") REFERENCES "DigitalSale"("id") ON DELETE SET NULL ON UPDATE CASCADE;
