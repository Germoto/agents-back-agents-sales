-- AlterTable: @username de WhatsApp como columna propia (se muestra junto al nombre)
ALTER TABLE "Customer" ADD COLUMN "waUsername" TEXT;

-- Backfill desde metadata.waContact.username (interceptor previo)
UPDATE "Customer" SET "waUsername" = (metadata #>> '{waContact,username}')
WHERE (metadata #>> '{waContact,username}') IS NOT NULL AND (metadata #>> '{waContact,username}') <> '';
