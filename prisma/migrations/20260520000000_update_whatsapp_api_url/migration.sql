-- Update WhatsApp provider API URL from old domain to new domain
UPDATE "WhatsappConfig"
SET "apiUrl" = 'https://smstools.pro/api/send/whatsapp'
WHERE "apiUrl" = 'https://smstools.molanosoft.com/api/send/whatsapp';
