-- Validación de comprobantes por negocio: AUTO (el agente valida, como siempre) u
-- OWNER (el dueño revisa cada pago). Aditiva: nace en AUTO para todos.
ALTER TABLE "PaymentConfig" ADD COLUMN IF NOT EXISTS "receiptReviewMode" TEXT NOT NULL DEFAULT 'AUTO';
ALTER TABLE "PaymentConfig" ADD COLUMN IF NOT EXISTS "receiptReviewMessage" TEXT;
