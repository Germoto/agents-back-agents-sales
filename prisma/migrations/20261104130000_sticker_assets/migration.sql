-- Galería de stickers por negocio (aditivo)
CREATE TABLE "StickerAsset" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'UPLOAD',
    "sourceUrl" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StickerAsset_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StickerAsset_companyId_lastUsedAt_idx" ON "StickerAsset"("companyId", "lastUsedAt");
CREATE INDEX "StickerAsset_companyId_sourceUrl_idx" ON "StickerAsset"("companyId", "sourceUrl");
ALTER TABLE "StickerAsset" ADD CONSTRAINT "StickerAsset_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
