-- Config singleton a nivel plataforma: rubros habilitados globalmente.
CREATE TABLE "PlatformConfig" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "enabledVerticals" "BusinessVertical"[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformConfig_pkey" PRIMARY KEY ("id")
);

-- Fila inicial: todos los rubros habilitados (no-breaking; el operador los recorta desde la UI).
INSERT INTO "PlatformConfig" ("id", "enabledVerticals", "updatedAt")
VALUES ('global', ARRAY['INFOPRODUCT', 'PHYSICAL_GOODS', 'RESTAURANT', 'STREAMER', 'SERVICE', 'OTHER']::"BusinessVertical"[], CURRENT_TIMESTAMP);
