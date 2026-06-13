-- Reintento automático de validación de pago (2º plano, +60s)
ALTER TYPE "ScheduledMessageType" ADD VALUE IF NOT EXISTS 'PAYMENT_RECHECK';
