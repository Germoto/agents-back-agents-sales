-- Chat de grupos de WhatsApp (SMS Tools). Aditiva: el chat nace apagado en todos
-- los grupos guardados; sin encenderlo, nada cambia.
DO $$ BEGIN
  CREATE TYPE "WhatsappGroupMessageKind" AS ENUM ('MENSAJE', 'EVENTO');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "WhatsappGroupMessageSender" AS ENUM ('TELEFONO', 'PANEL', 'COPILOTO', 'FLUJO');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "WhatsappGroup" ADD COLUMN IF NOT EXISTS "chatEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "WhatsappGroup" ADD COLUMN IF NOT EXISTS "watchedAt" TIMESTAMP(3);
ALTER TABLE "WhatsappGroup" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "WhatsappGroup" ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;
ALTER TABLE "WhatsappGroup" ADD COLUMN IF NOT EXISTS "participantCount" INTEGER;
ALTER TABLE "WhatsappGroup" ADD COLUMN IF NOT EXISTS "isAdmin" BOOLEAN;
ALTER TABLE "WhatsappGroup" ADD COLUMN IF NOT EXISTS "announce" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "WhatsappGroup" ADD COLUMN IF NOT EXISTS "participants" JSONB;
ALTER TABLE "WhatsappGroup" ADD COLUMN IF NOT EXISTS "infoSyncedAt" TIMESTAMP(3);
ALTER TABLE "WhatsappGroup" ADD COLUMN IF NOT EXISTS "lastMessageAt" TIMESTAMP(3);
ALTER TABLE "WhatsappGroup" ADD COLUMN IF NOT EXISTS "lastMessagePreview" TEXT;
ALTER TABLE "WhatsappGroup" ADD COLUMN IF NOT EXISTS "lastReadAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "WhatsappGroupMessage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "kind" "WhatsappGroupMessageKind" NOT NULL DEFAULT 'MENSAJE',
    "wamid" TEXT,
    "gatewayId" TEXT,
    "fromMe" BOOLEAN NOT NULL DEFAULT false,
    "sentBy" "WhatsappGroupMessageSender",
    "authorPhone" TEXT,
    "authorName" TEXT,
    "customerId" UUID,
    "message" TEXT,
    "mediaUrl" TEXT,
    "mediaType" TEXT,
    "fileName" TEXT,
    "quotedWamid" TEXT,
    "quotedPreview" TEXT,
    "mentions" TEXT,
    "reactions" JSONB,
    "poll" JSONB,
    "eventData" JSONB,
    "deliveryStatus" TEXT,
    "starredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsappGroupMessage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "WhatsappGroupMessage_groupId_wamid_key" ON "WhatsappGroupMessage"("groupId", "wamid");
CREATE INDEX IF NOT EXISTS "WhatsappGroupMessage_groupId_createdAt_idx" ON "WhatsappGroupMessage"("groupId", "createdAt");
CREATE INDEX IF NOT EXISTS "WhatsappGroupMessage_gatewayId_idx" ON "WhatsappGroupMessage"("gatewayId");
CREATE INDEX IF NOT EXISTS "WhatsappGroupMessage_wamid_idx" ON "WhatsappGroupMessage"("wamid");
DO $$ BEGIN
  ALTER TABLE "WhatsappGroupMessage" ADD CONSTRAINT "WhatsappGroupMessage_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "WhatsappGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
