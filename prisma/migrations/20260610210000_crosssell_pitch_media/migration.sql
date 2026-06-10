-- Multimedia opcional para el mensaje de enganche del cross-sell.
ALTER TABLE "DigitalDelivery"
  ADD COLUMN "crossSellPitchMediaUrl"  TEXT NOT NULL DEFAULT '',
  ADD COLUMN "crossSellPitchMediaType" TEXT NOT NULL DEFAULT '';
