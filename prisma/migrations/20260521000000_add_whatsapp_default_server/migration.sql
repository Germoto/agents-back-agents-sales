-- Add optional default WhatsApp server ID to WhatsappConfig
ALTER TABLE "WhatsappConfig" ADD COLUMN "defaultServerId" INTEGER;
