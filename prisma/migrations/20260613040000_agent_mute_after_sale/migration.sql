-- Flag: tras entregar una venta con catálogo de 1 producto sin enganche,
-- pasar al cliente a la lista de atención humana (default ON)
ALTER TABLE "AgentConfig" ADD COLUMN "muteAfterSale" BOOLEAN NOT NULL DEFAULT true;
