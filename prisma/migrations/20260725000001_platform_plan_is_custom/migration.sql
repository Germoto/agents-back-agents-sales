-- AlterTable: planes personalizados (snapshot por cliente, ocultos de los listados)
ALTER TABLE "PlatformPlan" ADD COLUMN "isCustom" BOOLEAN NOT NULL DEFAULT false;
