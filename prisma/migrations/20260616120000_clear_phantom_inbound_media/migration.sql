-- Limpia el "adjunto fantasma" en mensajes de texto del cliente: SMS Tools mandaba
-- la foto de perfil del remitente en TODOS los inbound (incluidos los de texto),
-- y mensajes antiguos quedaron con esa URL en mediaUrl. El parse ya las descarta
-- para mensajes nuevos; esto limpia los históricos.
--
-- Solo toca mensajes del cliente (USER) que tienen texto y NO tienen un tipo de
-- media explícito (mediaType IS NULL). Los adjuntos reales (imagen sola sin texto,
-- o con mediaType marcado) no se tocan.
UPDATE "ConversationMessage"
SET "mediaUrl" = NULL
WHERE "role" = 'USER'
  AND "mediaUrl" IS NOT NULL
  AND "mediaType" IS NULL
  AND "message" IS NOT NULL
  AND length(btrim("message")) > 0;
