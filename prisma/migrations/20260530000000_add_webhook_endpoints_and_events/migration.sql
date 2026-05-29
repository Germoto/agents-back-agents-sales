-- Migration: add_webhook_endpoints_and_events
-- Adds WebhookEndpoint and WebhookEvent tables and extends PaymentReceipt with
-- source/externalId fields for webhook-driven payment ingestion.

-- 1. Extend PaymentReceipt with new optional columns
ALTER TABLE "PaymentReceipt"
  ADD COLUMN IF NOT EXISTS "source"     TEXT,
  ADD COLUMN IF NOT EXISTS "externalId" TEXT;

-- Unique constraint for idempotency: same external payment cannot be registered twice
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentReceipt_source_externalId_key"
  ON "PaymentReceipt"("source", "externalId")
  WHERE "source" IS NOT NULL AND "externalId" IS NOT NULL;

-- 2. WebhookEndpoint table
CREATE TABLE IF NOT EXISTS "webhook_endpoints" (
  "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
  "companyId"   UUID         NOT NULL,
  "source"      TEXT         NOT NULL,
  "secret"      TEXT         NOT NULL,
  "active"      BOOLEAN      NOT NULL DEFAULT true,
  "autoApprove" BOOLEAN      NOT NULL DEFAULT true,
  "description" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt"  TIMESTAMP(3),

  CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webhook_endpoints_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "webhook_endpoints_companyId_idx"
  ON "webhook_endpoints"("companyId");

-- 3. WebhookEvent table
CREATE TABLE IF NOT EXISTS "webhook_events" (
  "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
  "endpointId" UUID         NOT NULL,
  "companyId"  UUID         NOT NULL,
  "source"     TEXT         NOT NULL,
  "externalId" TEXT         NOT NULL,
  "payload"    JSONB        NOT NULL,
  "status"     TEXT         NOT NULL,
  "error"      TEXT,
  "receiptId"  UUID,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webhook_events_source_externalId_key" UNIQUE ("source", "externalId"),
  CONSTRAINT "webhook_events_endpointId_fkey"
    FOREIGN KEY ("endpointId") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE,
  CONSTRAINT "webhook_events_receiptId_fkey"
    FOREIGN KEY ("receiptId") REFERENCES "PaymentReceipt"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "webhook_events_companyId_receivedAt_idx"
  ON "webhook_events"("companyId", "receivedAt");
