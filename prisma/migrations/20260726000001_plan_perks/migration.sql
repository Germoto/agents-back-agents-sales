-- AlterTable: atributos comerciales por paquete ("Soporte prioritario", etc.)
ALTER TABLE "PlatformPlan" ADD COLUMN "perks" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
