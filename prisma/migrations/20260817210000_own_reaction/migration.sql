-- Reacción del ASESOR sobre un mensaje (saliente vía /api/react del gateway).
ALTER TABLE "ConversationMessage" ADD COLUMN IF NOT EXISTS "ownReaction" TEXT;
