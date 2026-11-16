-- Mensaje propio que acompaña la invitación a un grupo de WhatsApp.
-- Aditiva: null = apagado (no se envía nada extra).
ALTER TABLE "WhatsappGroup" ADD COLUMN IF NOT EXISTS "inviteMessage" TEXT;
