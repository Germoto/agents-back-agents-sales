-- Conector MCP por tenant: token único para exponer las tools del Copiloto
-- como servidor MCP remoto (configurar FlowApp desde Claude). OFF por defecto.
CREATE TABLE IF NOT EXISTS "McpConfig" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "McpConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "McpConfig_companyId_key" ON "McpConfig"("companyId");
CREATE UNIQUE INDEX IF NOT EXISTS "McpConfig_token_key" ON "McpConfig"("token");

ALTER TABLE "McpConfig" ADD CONSTRAINT "McpConfig_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
