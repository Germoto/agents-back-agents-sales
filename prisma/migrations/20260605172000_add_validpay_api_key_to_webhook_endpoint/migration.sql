-- AlterTable: add validpayApiKey to webhook_endpoints for bidirectional ValidPay integration
ALTER TABLE "webhook_endpoints" ADD COLUMN "validpayApiKey" TEXT;
