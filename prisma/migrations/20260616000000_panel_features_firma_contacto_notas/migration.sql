-- Lote de mejoras del panel: firma de empresa, ficha de contacto editable,
-- comando de respuestas rápidas y notas internas por contacto.

-- Firma anexada a mensajes automáticos (agente IA + flujos)
ALTER TABLE "Company" ADD COLUMN "firmaEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Company" ADD COLUMN "firmaText" TEXT;

-- Ficha de contacto editable
ALTER TABLE "Customer" ADD COLUMN "sexo" TEXT;
ALTER TABLE "Customer" ADD COLUMN "fechaNacimiento" TIMESTAMP(3);
ALTER TABLE "Customer" ADD COLUMN "idioma" TEXT;
ALTER TABLE "Customer" ADD COLUMN "origenDeLead" TEXT;

-- Comando "/saludo" para invocar respuestas rápidas
ALTER TABLE "QuickReply" ADD COLUMN "command" TEXT;
CREATE UNIQUE INDEX "QuickReply_companyId_command_key" ON "QuickReply"("companyId", "command");

-- Notas internas por contacto
CREATE TABLE "ContactNote" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "conversationId" UUID,
    "text" TEXT,
    "mediaUrl" TEXT,
    "mediaType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactNote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ContactNote_companyId_customerId_createdAt_idx" ON "ContactNote"("companyId", "customerId", "createdAt");

ALTER TABLE "ContactNote" ADD CONSTRAINT "ContactNote_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactNote" ADD CONSTRAINT "ContactNote_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactNote" ADD CONSTRAINT "ContactNote_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
