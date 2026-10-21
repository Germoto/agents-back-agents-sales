-- Invitación a la tienda web como último mensaje de la entrega (por producto).
ALTER TABLE "DigitalDelivery" ADD COLUMN IF NOT EXISTS "storeInviteEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "DigitalDelivery" ADD COLUMN IF NOT EXISTS "storeInviteText" TEXT NOT NULL DEFAULT '';
