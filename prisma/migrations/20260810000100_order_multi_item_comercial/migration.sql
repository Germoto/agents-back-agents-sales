-- Pedidos multi-ítem con historial de estados (rubro Comercial)

ALTER TABLE "Order" ADD COLUMN "total" TEXT;
ALTER TABLE "Order" ADD COLUMN "paymentStatus" TEXT;
ALTER TABLE "Order" ADD COLUMN "paymentMethod" TEXT;
ALTER TABLE "Order" ADD COLUMN "comprobanteId" UUID;

CREATE TABLE "OrderItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orderId" UUID NOT NULL,
    "productId" UUID,
    "productName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" TEXT NOT NULL,
    "variantLabel" TEXT,
    "lineTotal" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "OrderStatusHistory" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orderId" UUID NOT NULL,
    "fromStatus" "OrderStatus",
    "toStatus" "OrderStatus" NOT NULL,
    "changedBy" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderStatusHistory_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OrderStatusHistory_orderId_createdAt_idx" ON "OrderStatusHistory"("orderId", "createdAt");
ALTER TABLE "OrderStatusHistory" ADD CONSTRAINT "OrderStatusHistory_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: cada Order mono-producto existente -> un OrderItem
INSERT INTO "OrderItem" ("orderId", "productId", "productName", "quantity", "unitPrice", "lineTotal", "createdAt")
SELECT o."id", o."productId", p."name", o."quantity", p."price", p."price", o."createdAt"
FROM "Order" o JOIN "Product" p ON p."id" = o."productId";

-- Backfill: estado inicial de cada Order existente en el historial
INSERT INTO "OrderStatusHistory" ("orderId", "toStatus", "changedBy", "note", "createdAt")
SELECT "id", "status", 'sistema', 'Registro inicial', "createdAt" FROM "Order";
