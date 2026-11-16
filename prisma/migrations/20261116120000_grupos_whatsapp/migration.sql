-- Grupos de WhatsApp (SMS Tools): grupos guardados del negocio, cola de altas a grupos
-- y configuración opcional por producto y del agente. Aditiva: todo NULL = como hoy.
DO $$ BEGIN
  CREATE TYPE "WhatsappGroupMemberStatus" AS ENUM ('PENDIENTE', 'PROCESANDO', 'AGREGADO', 'INVITADO', 'YA_ESTABA', 'EN_ESPERA', 'FALLIDO', 'CANCELADO');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "WhatsappGroupAddSource" AS ENUM ('VENTA', 'PRESENTACION', 'COBRO', 'MANUAL', 'LOTE', 'FLUJO', 'AGENTE', 'COPILOTO');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "whatsappGroupConfig" JSONB;
ALTER TABLE "AgentConfig" ADD COLUMN IF NOT EXISTS "groupToolConfig" JSONB;

CREATE TABLE IF NOT EXISTS "WhatsappGroup" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "gid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pausedReason" TEXT,
    "pausedAt" TIMESTAMP(3),
    "nextBatchAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappGroup_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "WhatsappGroup_companyId_gid_key" ON "WhatsappGroup"("companyId", "gid");
CREATE INDEX IF NOT EXISTS "WhatsappGroup_companyId_idx" ON "WhatsappGroup"("companyId");
DO $$ BEGIN
  ALTER TABLE "WhatsappGroup" ADD CONSTRAINT "WhatsappGroup_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "WhatsappGroupMember" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "status" "WhatsappGroupMemberStatus" NOT NULL DEFAULT 'PENDIENTE',
    "source" "WhatsappGroupAddSource" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "immediate" BOOLEAN NOT NULL DEFAULT false,
    "recheck" BOOLEAN NOT NULL DEFAULT false,
    "lastResult" TEXT,
    "lastCode" INTEGER,
    "claimedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappGroupMember_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "WhatsappGroupMember_groupId_customerId_key" ON "WhatsappGroupMember"("groupId", "customerId");
CREATE INDEX IF NOT EXISTS "WhatsappGroupMember_status_nextAttemptAt_idx" ON "WhatsappGroupMember"("status", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "WhatsappGroupMember_groupId_status_idx" ON "WhatsappGroupMember"("groupId", "status");
CREATE INDEX IF NOT EXISTS "WhatsappGroupMember_companyId_customerId_idx" ON "WhatsappGroupMember"("companyId", "customerId");
DO $$ BEGIN
  ALTER TABLE "WhatsappGroupMember" ADD CONSTRAINT "WhatsappGroupMember_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "WhatsappGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "WhatsappGroupMember" ADD CONSTRAINT "WhatsappGroupMember_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
