-- Mensaje de cobro propio del negocio (cobro total y cobro de adelanto).
-- Aditiva: null = la plantilla de fábrica de siempre.
ALTER TABLE "PaymentConfig" ADD COLUMN IF NOT EXISTS "chargeMessage" TEXT;
ALTER TABLE "PaymentConfig" ADD COLUMN IF NOT EXISTS "advanceChargeMessage" TEXT;
