-- Acciones HTTP (conexiones, acciones, historial) + modo de entrega HTTP_ACTION (aditivo)
CREATE TYPE "HttpAuthType" AS ENUM ('NONE', 'BEARER', 'HEADER', 'QUERY', 'BASIC');
CREATE TYPE "HttpBodyType" AS ENUM ('NONE', 'JSON', 'FORM', 'RAW');

ALTER TYPE "DeliveryAssignmentMode" ADD VALUE IF NOT EXISTS 'HTTP_ACTION';

CREATE TABLE "HttpConnection" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "baseUrl" TEXT NOT NULL,
  "authType" "HttpAuthType" NOT NULL DEFAULT 'NONE',
  "authName" TEXT,
  "authSecret" TEXT,
  "headers" JSONB NOT NULL DEFAULT '{}',
  "timeoutMs" INTEGER NOT NULL DEFAULT 15000,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HttpConnection_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "HttpConnection_companyId_idx" ON "HttpConnection"("companyId");
ALTER TABLE "HttpConnection" ADD CONSTRAINT "HttpConnection_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "HttpAction" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "connectionId" UUID,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "method" TEXT NOT NULL DEFAULT 'POST',
  "url" TEXT NOT NULL,
  "query" JSONB NOT NULL DEFAULT '[]',
  "headers" JSONB NOT NULL DEFAULT '[]',
  "bodyType" "HttpBodyType" NOT NULL DEFAULT 'JSON',
  "body" TEXT,
  "responseVar" TEXT NOT NULL DEFAULT 'api',
  "retries" INTEGER NOT NULL DEFAULT 1,
  "agentEnabled" BOOLEAN NOT NULL DEFAULT false,
  "agentDescription" TEXT,
  "agentParams" JSONB NOT NULL DEFAULT '[]',
  "oncePerCustomer" BOOLEAN NOT NULL DEFAULT false,
  "agentResultHint" TEXT,
  "lastRunAt" TIMESTAMP(3),
  "lastRunOk" BOOLEAN,
  "lastResponseKeys" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HttpAction_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "HttpAction_companyId_idx" ON "HttpAction"("companyId");
ALTER TABLE "HttpAction" ADD CONSTRAINT "HttpAction_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HttpAction" ADD CONSTRAINT "HttpAction_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "HttpConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "HttpActionRun" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "actionId" UUID,
  "source" TEXT NOT NULL,
  "customerId" UUID,
  "conversationId" UUID,
  "receiptId" UUID,
  "productId" UUID,
  "idempotencyKey" TEXT,
  "status" TEXT NOT NULL,
  "httpStatus" INTEGER,
  "durationMs" INTEGER NOT NULL DEFAULT 0,
  "request" JSONB NOT NULL,
  "response" JSONB,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HttpActionRun_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HttpActionRun_idempotencyKey_key" ON "HttpActionRun"("idempotencyKey");
CREATE INDEX "HttpActionRun_companyId_createdAt_idx" ON "HttpActionRun"("companyId", "createdAt");
CREATE INDEX "HttpActionRun_actionId_createdAt_idx" ON "HttpActionRun"("actionId", "createdAt");
CREATE INDEX "HttpActionRun_actionId_customerId_idx" ON "HttpActionRun"("actionId", "customerId");
ALTER TABLE "HttpActionRun" ADD CONSTRAINT "HttpActionRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HttpActionRun" ADD CONSTRAINT "HttpActionRun_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "HttpAction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DigitalDelivery" ADD COLUMN "httpActionId" UUID;
ALTER TABLE "DigitalDelivery" ADD CONSTRAINT "DigitalDelivery_httpActionId_fkey" FOREIGN KEY ("httpActionId") REFERENCES "HttpAction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
