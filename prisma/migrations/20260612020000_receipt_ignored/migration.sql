-- Estado "IGNORADO" para comprobantes que no corresponden a una venta (otros
-- pagos): no sincroniza con ValidPay ni toca la venta digital.
ALTER TYPE "ReceiptStatus" ADD VALUE IF NOT EXISTS 'IGNORADO';
