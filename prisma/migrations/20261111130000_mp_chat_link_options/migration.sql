-- Opciones del link de Mercado Pago en el chat. Aditiva y sin defaults: NULL = como hoy.
-- mpChatLinkMessage: mensaje propio del link enviado aparte (NULL = el de fábrica).
-- mpChatLinkExpiryDays: días de vigencia del link del chat (NULL = no vence).
ALTER TABLE "PaymentConfig" ADD COLUMN IF NOT EXISTS "mpChatLinkMessage" TEXT;
ALTER TABLE "PaymentConfig" ADD COLUMN IF NOT EXISTS "mpChatLinkExpiryDays" INTEGER;
