-- Enlace fijo de videollamada por defecto del negocio (citas online). Aditivo.
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "meetingUrl" TEXT;
