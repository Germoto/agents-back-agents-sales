-- Entrega a nivel negocio + override de recordatorios por producto.
ALTER TABLE "Company" ADD COLUMN "deliveryConfig" JSONB;
ALTER TABLE "Product" ADD COLUMN "reminderConfig" JSONB;
