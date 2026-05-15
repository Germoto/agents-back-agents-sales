CREATE TYPE "ProductFileType" AS ENUM ('IMAGE', 'PDF', 'VIDEO', 'OTHER');

CREATE TABLE "ProductFile" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "productId" UUID NOT NULL,
  "type" "ProductFileType" NOT NULL,
  "url" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProductFile_pkey" PRIMARY KEY ("id")
);

INSERT INTO "ProductFile" ("productId", "type", "url", "description", "sortOrder")
SELECT "productId", 'IMAGE'::"ProductFileType", "imageUrl", 'Imagen principal del producto', 0
FROM "ProductMedia"
WHERE "imageUrl" IS NOT NULL;

INSERT INTO "ProductFile" ("productId", "type", "url", "description", "sortOrder")
SELECT "productId", 'PDF'::"ProductFileType", "pdfUrl", 'Documento PDF del producto', 1
FROM "ProductMedia"
WHERE "pdfUrl" IS NOT NULL;

INSERT INTO "ProductFile" ("productId", "type", "url", "description", "sortOrder")
SELECT "productId", 'VIDEO'::"ProductFileType", "videoUrl", 'Video del producto', 2
FROM "ProductMedia"
WHERE "videoUrl" IS NOT NULL;

CREATE INDEX "ProductFile_productId_sortOrder_idx" ON "ProductFile"("productId", "sortOrder");

ALTER TABLE "ProductFile"
ADD CONSTRAINT "ProductFile_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP TABLE "ProductMedia";
