-- Rubro Comercial: estados de pedido para pago adelantado / entrega
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'PENDIENTE_PAGO';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'PAGADO';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'ENTREGADO';
