-- Mensajes adicionales (texto/multimedia) que acompañan la info completa de presentación.
-- Array de {message,mediaUrl,mediaType}; mismo formato que DigitalDelivery.followupMessages.
ALTER TABLE "Product"
  ADD COLUMN "presentationFollowups" JSONB NOT NULL DEFAULT '[]';
