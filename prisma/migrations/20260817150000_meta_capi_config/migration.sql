-- Meta Conversions API por tenant: reportar ventas (Purchase) con el ctwa_clid
-- del lead para que Meta optimice las campañas hacia compradores.
CREATE TABLE IF NOT EXISTS "MetaCapiConfig" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "datasetId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "testEventCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MetaCapiConfig_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "MetaCapiConfig_companyId_key" ON "MetaCapiConfig"("companyId");
ALTER TABLE "MetaCapiConfig" ADD CONSTRAINT "MetaCapiConfig_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
