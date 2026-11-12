-- Tienda web para productos físicos: estado del pedido registrado sin pago en línea
-- (contra entrega). Va sola: Postgres no deja usar un valor nuevo de enum en la misma
-- transacción en que se crea.
ALTER TYPE "StoreOrderStatus" ADD VALUE IF NOT EXISTS 'CONFIRMADO';
