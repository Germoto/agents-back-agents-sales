-- Mercado Pago por canal (chat / tienda web). Aditiva, default true = sin cambio de comportamiento.
ALTER TABLE "PaymentConfig" ADD COLUMN IF NOT EXISTS "mpChatEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "PaymentConfig" ADD COLUMN IF NOT EXISTS "mpStoreEnabled" BOOLEAN NOT NULL DEFAULT true;
