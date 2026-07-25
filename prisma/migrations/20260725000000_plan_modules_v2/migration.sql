-- AlterEnum: módulos nuevos de paquetes (Chat Web, Mercado Pago, Reportes, Webhooks/API)
ALTER TYPE "PlanModule" ADD VALUE IF NOT EXISTS 'WEBCHAT';
ALTER TYPE "PlanModule" ADD VALUE IF NOT EXISTS 'MERCADOPAGO';
ALTER TYPE "PlanModule" ADD VALUE IF NOT EXISTS 'REPORTS';
ALTER TYPE "PlanModule" ADD VALUE IF NOT EXISTS 'WEBHOOKS';
