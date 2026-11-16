-- Ritmo de altas a grupos de WhatsApp por negocio ({ perMinute, perHour, perDay }).
-- Aditiva: sin valor guardado rige el ritmo por defecto (1 por minuto, 30 por hora, 200 por día).
ALTER TABLE "WhatsappConfig" ADD COLUMN IF NOT EXISTS "groupAddPacing" JSONB;
