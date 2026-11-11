-- Modo del link de Mercado Pago en el chat. Aditiva: ALWAYS = el link va en el
-- mensaje de cobro (comportamiento de hoy); ON_REQUEST = solo cuando el cliente lo pide.
ALTER TABLE "PaymentConfig" ADD COLUMN IF NOT EXISTS "mpChatMode" TEXT NOT NULL DEFAULT 'ALWAYS';
