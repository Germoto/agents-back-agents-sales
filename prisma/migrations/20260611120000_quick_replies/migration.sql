-- Respuestas rápidas del panel de conversaciones (secuencias de mensajes) + categorías.
CREATE TABLE "QuickReplyCategory" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuickReplyCategory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "QuickReplyCategory_companyId_name_key" ON "QuickReplyCategory"("companyId", "name");
CREATE INDEX "QuickReplyCategory_companyId_sortOrder_idx" ON "QuickReplyCategory"("companyId", "sortOrder");

ALTER TABLE "QuickReplyCategory" ADD CONSTRAINT "QuickReplyCategory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "QuickReply" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "categoryId" UUID,
    "title" TEXT NOT NULL,
    "messages" JSONB NOT NULL,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuickReply_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "QuickReply_companyId_updatedAt_idx" ON "QuickReply"("companyId", "updatedAt");

ALTER TABLE "QuickReply" ADD CONSTRAINT "QuickReply_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuickReply" ADD CONSTRAINT "QuickReply_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "QuickReplyCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tipo del adjunto en mensajes de conversación (para render correcto en el panel).
ALTER TABLE "ConversationMessage" ADD COLUMN "mediaType" TEXT;
