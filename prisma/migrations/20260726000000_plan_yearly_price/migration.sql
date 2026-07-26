-- AlterTable: precio anual con descuento por paquete (null = sin modalidad anual)
ALTER TABLE "PlatformPlan" ADD COLUMN "priceUsdYearly" DECIMAL(10,2);
ALTER TABLE "PlatformPlan" ADD COLUMN "pricePenYearly" DECIMAL(10,2);
