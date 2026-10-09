-- Archivos de entrega protegidos (enlace firmado). Aditiva, default false = sin cambio.
ALTER TABLE "ProductFile" ADD COLUMN IF NOT EXISTS "privateDownload" BOOLEAN NOT NULL DEFAULT false;
