-- Migration: add_eventtype_to_webhook_event
-- Cambia la clave de idempotencia de WebhookEvent de (source, externalId)
-- a (source, externalId, eventType) para que payment.received y payment.validated
-- del mismo pago no colisionen y ambos sean procesados correctamente.

-- 1. Agregar columna eventType con default vacío (seguro para datos existentes)
ALTER TABLE "webhook_events"
  ADD COLUMN IF NOT EXISTS "eventType" TEXT NOT NULL DEFAULT '';

-- 2. Eliminar el constraint único anterior
ALTER TABLE "webhook_events"
  DROP CONSTRAINT IF EXISTS "webhook_events_source_externalId_key";

-- 3. Crear nuevo constraint que incluye eventType
ALTER TABLE "webhook_events"
  ADD CONSTRAINT "webhook_events_source_externalId_eventType_key"
  UNIQUE ("source", "externalId", "eventType");
