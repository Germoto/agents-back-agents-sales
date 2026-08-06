-- Nuevo modo de cobro: el CLIENTE elige entre pago adelantado o contra entrega.
-- ADD VALUE de enum debe ir en una migración aislada (regla Postgres: no puede
-- usarse el valor nuevo en la misma transacción que lo crea).
ALTER TYPE "PaymentMode" ADD VALUE IF NOT EXISTS 'CUSTOMER_CHOICE';
