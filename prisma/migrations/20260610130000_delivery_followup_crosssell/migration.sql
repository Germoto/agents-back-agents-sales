-- Entrega del acceso más dinámica: mensaje adicional (media+texto) + cross-sell.
ALTER TABLE "DigitalDelivery"
  ADD COLUMN "followupMessage"   TEXT NOT NULL DEFAULT '',
  ADD COLUMN "followupMediaUrl"  TEXT NOT NULL DEFAULT '',
  ADD COLUMN "followupMediaType" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "crossSellProductId" UUID;

-- Backfill: el mensaje de entrega ahora son las instrucciones (con el link dentro).
-- Para productos existentes que tenían el link en el campo aparte, lo anexamos a las
-- instrucciones si aún no lo contienen, para no romper su entrega.
UPDATE "DigitalDelivery"
SET "instructions" =
  CASE
    WHEN COALESCE("instructions", '') = '' THEN "link"
    ELSE "instructions" || E'\n' || "link"
  END
WHERE COALESCE("link", '') <> ''
  AND POSITION("link" IN COALESCE("instructions", '')) = 0;
