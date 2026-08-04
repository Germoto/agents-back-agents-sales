-- Widget de reservas embebible (el tenant lo pega en su propia web)

CREATE TABLE "BookingWidgetConfig" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "token" TEXT NOT NULL,
    "allowedOrigins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "headline" TEXT NOT NULL DEFAULT '',
    "accentColor" TEXT NOT NULL DEFAULT '',
    "successMessage" TEXT NOT NULL DEFAULT '',
    "productIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingWidgetConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BookingWidgetConfig_companyId_key" ON "BookingWidgetConfig"("companyId");
CREATE UNIQUE INDEX "BookingWidgetConfig_token_key" ON "BookingWidgetConfig"("token");

ALTER TABLE "BookingWidgetConfig" ADD CONSTRAINT "BookingWidgetConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
