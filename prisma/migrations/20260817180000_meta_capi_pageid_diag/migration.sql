-- CAPI: page_id requerido por Meta para eventos business_messaging (CTWA)
-- + diagnóstico del último intento de envío (visible en el panel).
ALTER TABLE "MetaCapiConfig" ADD COLUMN IF NOT EXISTS "pageId" TEXT;
ALTER TABLE "MetaCapiConfig" ADD COLUMN IF NOT EXISTS "lastAttemptAt" TIMESTAMP(3);
ALTER TABLE "MetaCapiConfig" ADD COLUMN IF NOT EXISTS "lastResult" TEXT;
