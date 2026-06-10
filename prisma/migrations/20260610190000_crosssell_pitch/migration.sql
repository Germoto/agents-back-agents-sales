-- Mensaje configurable con el que el bot ofrece el producto relacionado (cross-sell).
ALTER TABLE "DigitalDelivery"
  ADD COLUMN "crossSellPitch" TEXT NOT NULL DEFAULT '';
