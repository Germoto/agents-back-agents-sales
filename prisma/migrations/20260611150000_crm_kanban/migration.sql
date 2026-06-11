-- CRM kanban: tableros, columnas, placements de clientes, etiquetas internas y
-- valores de negocio manuales.

CREATE TABLE "Crm" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT NOT NULL DEFAULT '#6366f1',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Crm_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Crm_companyId_name_key" ON "Crm"("companyId", "name");
CREATE INDEX "Crm_companyId_sortOrder_idx" ON "Crm"("companyId", "sortOrder");

ALTER TABLE "Crm" ADD CONSTRAINT "Crm_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CrmColumn" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "crmId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmColumn_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CrmColumn_crmId_sortOrder_idx" ON "CrmColumn"("crmId", "sortOrder");

ALTER TABLE "CrmColumn" ADD CONSTRAINT "CrmColumn_crmId_fkey" FOREIGN KEY ("crmId") REFERENCES "Crm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmColumn" ADD CONSTRAINT "CrmColumn_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CrmCard" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "crmId" UUID NOT NULL,
    "columnId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmCard_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CrmCard_crmId_customerId_key" ON "CrmCard"("crmId", "customerId");
CREATE INDEX "CrmCard_columnId_sortOrder_idx" ON "CrmCard"("columnId", "sortOrder");

ALTER TABLE "CrmCard" ADD CONSTRAINT "CrmCard_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmCard" ADD CONSTRAINT "CrmCard_crmId_fkey" FOREIGN KEY ("crmId") REFERENCES "Crm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmCard" ADD CONSTRAINT "CrmCard_columnId_fkey" FOREIGN KEY ("columnId") REFERENCES "CrmColumn"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmCard" ADD CONSTRAINT "CrmCard_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CustomerTag" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#22c55e',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerTag_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerTag_companyId_name_key" ON "CustomerTag"("companyId", "name");

ALTER TABLE "CustomerTag" ADD CONSTRAINT "CustomerTag_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CustomerTagLink" (
    "customerId" UUID NOT NULL,
    "tagId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerTagLink_pkey" PRIMARY KEY ("customerId", "tagId")
);

CREATE INDEX "CustomerTagLink_tagId_idx" ON "CustomerTagLink"("tagId");

ALTER TABLE "CustomerTagLink" ADD CONSTRAINT "CustomerTagLink_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerTagLink" ADD CONSTRAINT "CustomerTagLink_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "CustomerTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CustomerDeal" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerDeal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CustomerDeal_companyId_customerId_idx" ON "CustomerDeal"("companyId", "customerId");

ALTER TABLE "CustomerDeal" ADD CONSTRAINT "CustomerDeal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerDeal" ADD CONSTRAINT "CustomerDeal_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
