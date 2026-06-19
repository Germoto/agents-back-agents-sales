-- Check por producto: tras vender este producto, forzar el pase a atención humana
-- (override de la heurística por defecto AgentConfig.muteAfterSale).
ALTER TABLE "Product" ADD COLUMN "pauseHumanAfterSale" BOOLEAN NOT NULL DEFAULT false;
