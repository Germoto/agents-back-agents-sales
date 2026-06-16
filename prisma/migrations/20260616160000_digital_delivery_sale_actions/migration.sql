-- Acciones al cerrar la venta, configurables por producto digital: mover al cliente
-- a una pestaña del CRM y/o asignarle etiquetas.
ALTER TABLE "DigitalDelivery"
  ADD COLUMN "onSaleCrmId" UUID,
  ADD COLUMN "onSaleCrmColumnId" UUID,
  ADD COLUMN "onSaleTagIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];
