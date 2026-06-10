-- Permitir VARIOS mensajes adicionales tras la entrega (array JSON).
ALTER TABLE "DigitalDelivery"
  ADD COLUMN "followupMessages" JSONB NOT NULL DEFAULT '[]';

-- Backfill: convertir el mensaje adicional single existente en un array de 1 elemento.
UPDATE "DigitalDelivery"
SET "followupMessages" = jsonb_build_array(
  jsonb_build_object(
    'message', "followupMessage",
    'mediaUrl', "followupMediaUrl",
    'mediaType', "followupMediaType"
  )
)
WHERE COALESCE("followupMessage", '') <> '' OR COALESCE("followupMediaUrl", '') <> '';
