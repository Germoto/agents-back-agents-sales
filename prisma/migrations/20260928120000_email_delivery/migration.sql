-- Entrega del infoproducto por correo a pedido del cliente.
-- Aditiva: defaults/nullable, sin backfill.
ALTER TABLE "DigitalDelivery" ADD COLUMN IF NOT EXISTS "emailEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "DigitalDelivery" ADD COLUMN IF NOT EXISTS "emailSubject" TEXT;
ALTER TABLE "DigitalDelivery" ADD COLUMN IF NOT EXISTS "emailBody" TEXT;
ALTER TABLE "ProductFile" ADD COLUMN IF NOT EXISTS "sendByEmail" BOOLEAN NOT NULL DEFAULT false;
