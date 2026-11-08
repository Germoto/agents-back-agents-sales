-- Asistente de arranque + historial del Copiloto (tablas nuevas, aditivo)
CREATE TABLE "CompanyOnboarding" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "step" INTEGER NOT NULL DEFAULT 1,
    "draft" JSONB,
    "skipCount" INTEGER NOT NULL DEFAULT 0,
    "lastSkippedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "fullMenu" BOOLEAN NOT NULL DEFAULT false,
    "presetVertical" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CompanyOnboarding_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CompanyOnboarding_companyId_key" ON "CompanyOnboarding"("companyId");
ALTER TABLE "CompanyOnboarding" ADD CONSTRAINT "CompanyOnboarding_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CopilotThread" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'panel',
    "messages" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CopilotThread_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CopilotThread_userId_kind_key" ON "CopilotThread"("userId", "kind");
CREATE INDEX "CopilotThread_companyId_idx" ON "CopilotThread"("companyId");
ALTER TABLE "CopilotThread" ADD CONSTRAINT "CopilotThread_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CopilotThread" ADD CONSTRAINT "CopilotThread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
