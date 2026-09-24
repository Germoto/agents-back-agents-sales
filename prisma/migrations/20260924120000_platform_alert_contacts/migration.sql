-- Avisos al dueño de la plataforma (pre-registros): email y teléfono WhatsApp.
-- Aditiva: nullable, sin backfill.
ALTER TABLE "PlatformConfig" ADD COLUMN IF NOT EXISTS "alertEmail" TEXT;
ALTER TABLE "PlatformConfig" ADD COLUMN IF NOT EXISTS "alertPhone" TEXT;
