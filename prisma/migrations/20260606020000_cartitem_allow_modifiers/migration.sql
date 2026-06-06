-- Restaurante: permitir varias líneas del mismo producto con distintos modificadores.
DROP INDEX IF EXISTS "CartItem_cartId_productId_key";
CREATE INDEX IF NOT EXISTS "CartItem_cartId_productId_idx" ON "CartItem"("cartId", "productId");
