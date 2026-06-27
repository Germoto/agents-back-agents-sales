-- Acciones al ENVIAR la info completa (presentación), configurables por producto digital:
-- mover al cliente a una pestaña del CRM y/o asignarle etiquetas. Mismo patrón que onSale*.
ALTER TABLE "DigitalDelivery"
  ADD COLUMN "onPresentationCrmId" UUID,
  ADD COLUMN "onPresentationCrmColumnId" UUID,
  ADD COLUMN "onPresentationTagIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];
