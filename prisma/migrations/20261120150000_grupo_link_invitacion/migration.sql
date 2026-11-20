-- Link de invitación del grupo de WhatsApp (lo pega el dueño). Se envía por mensaje a
-- los clientes con número oculto. Aditiva: NULL = como hoy.
ALTER TABLE "WhatsappGroup" ADD COLUMN IF NOT EXISTS "inviteLink" TEXT;
