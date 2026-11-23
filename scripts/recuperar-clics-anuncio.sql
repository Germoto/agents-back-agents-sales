-- Recupera los clics de anuncio que se perdieron cuando regía «la primera gana»:
-- mensajes que llegaron desde un anuncio DISTINTO al guardado en la ficha del cliente.
-- La información sigue en ConversationMessage.rawPayload (webhook original).
--
-- SOLO INSERTA toques (AdTouch) y actualiza el «último anuncio» de la ficha. No borra
-- ni modifica mensajes, ventas ni el anuncio de origen. Los toques nacen ya atendidos
-- (flowConsumedAt): NO dispara flujos, etiquetas ni mensajes a nadie.
-- Idempotente: se puede correr dos veces sin duplicar.
--
-- Uso (producción, solo con autorización del dueño):
--   psql ... -v dias=90 -f recuperar-clics-anuncio.sql
\if :{?dias}
\else
\set dias 90
\endif

BEGIN;

WITH msgs AS (
  SELECT m."companyId", m."customerId", m."conversationId", m."createdAt",
         substring(m."rawPayload"::text from '"(?:ad_source_id|source_id)"\s*:\s*"([^"]+)"')   AS ad_id,
         substring(m."rawPayload"::text from '"(?:ad_title|headline)"\s*:\s*"((?:[^"\\]|\\.)*)"') AS ad_title,
         substring(m."rawPayload"::text from '"ctwa_clid"\s*:\s*"([^"]+)"')                    AS clid,
         substring(m."rawPayload"::text from '"(?:ad_source_url|source_url)"\s*:\s*"([^"]+)"') AS ad_url
  FROM "ConversationMessage" m
  WHERE m.role = 'USER'
    AND m."createdAt" > now() - (:dias || ' days')::interval
    AND (m."rawPayload"::text LIKE '%ad_source_id%' OR m."rawPayload"::text LIKE '%ctwa_clid%')
),
nuevos AS (
  -- Un toque por clic: primer mensaje de cada (cliente, click-id); sin click-id, por (cliente, anuncio, día).
  SELECT DISTINCT ON (x."customerId", COALESCE(x.clid, x.ad_id || ':' || x."createdAt"::date))
         x.*
  FROM msgs x
  WHERE x.ad_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "AdTouch" t
      WHERE t."customerId" = x."customerId"
        AND ( (x.clid IS NOT NULL AND t."ctwaClid" = x.clid)
           OR (x.clid IS NULL AND t."adSourceId" = x.ad_id AND t."createdAt"::date = x."createdAt"::date) )
    )
  ORDER BY x."customerId", COALESCE(x.clid, x.ad_id || ':' || x."createdAt"::date), x."createdAt" ASC
),
ins AS (
  INSERT INTO "AdTouch" ("companyId", "customerId", "conversationId", "adSourceId", "adTitle", "ctwaClid", "adSourceUrl", "flowConsumedAt", "createdAt")
  SELECT "companyId", "customerId", "conversationId", ad_id, NULLIF(replace(ad_title, '\"', '"'), ''), clid, ad_url, now(), "createdAt"
  FROM nuevos
  RETURNING "customerId"
)
SELECT count(*) AS toques_recuperados, count(DISTINCT "customerId") AS clientes FROM ins;

-- Último anuncio de la ficha = toque más reciente de cada cliente.
UPDATE "Customer" c
SET "lastAdSourceId" = t."adSourceId", "lastAdTitle" = t."adTitle", "lastCtwaClid" = t."ctwaClid", "lastAdAt" = t."createdAt"
FROM (
  SELECT DISTINCT ON ("customerId") "customerId", "adSourceId", "adTitle", "ctwaClid", "createdAt"
  FROM "AdTouch" ORDER BY "customerId", "createdAt" DESC
) t
WHERE c.id = t."customerId"
  AND (c."lastAdAt" IS NULL OR c."lastAdAt" < t."createdAt");

-- Ventas aprobadas: el anuncio vigente al momento de cada venta (corrige las que el
-- relleno inicial dejó con el primer anuncio y en realidad venían de uno posterior).
UPDATE "PaymentReceipt" r
SET "adSourceId" = t."adSourceId", "adTitle" = t."adTitle"
FROM (
  SELECT r2.id, a."adSourceId", a."adTitle"
  FROM "PaymentReceipt" r2
  CROSS JOIN LATERAL (
    SELECT x."adSourceId", x."adTitle"
    FROM "AdTouch" x
    WHERE x."customerId" = r2."customerId"
      AND x."createdAt" <= COALESCE(r2."validatedAt", r2."occurredAt", r2."createdAt") + interval '2 minutes'
    ORDER BY x."createdAt" DESC
    LIMIT 1
  ) a
  WHERE r2.status = 'APROBADO' AND r2."customerId" IS NOT NULL
    AND r2."createdAt" > now() - (:dias || ' days')::interval
) t
WHERE r.id = t.id
  AND r."adSourceId" IS DISTINCT FROM t."adSourceId";

COMMIT;
