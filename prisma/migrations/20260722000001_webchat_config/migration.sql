-- CreateTable
CREATE TABLE "WebchatConfig" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "token" TEXT NOT NULL,
    "allowedOrigins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "welcomeMessage" TEXT NOT NULL DEFAULT '',
    "accentColor" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebchatConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebchatConfig_companyId_key" ON "WebchatConfig"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "WebchatConfig_token_key" ON "WebchatConfig"("token");

-- AddForeignKey
ALTER TABLE "WebchatConfig" ADD CONSTRAINT "WebchatConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
