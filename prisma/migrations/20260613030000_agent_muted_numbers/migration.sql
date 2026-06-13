-- Números en atención humana forzada (el bot no responde; pasa a HUMANO)
ALTER TABLE "AgentConfig" ADD COLUMN "mutedNumbers" JSONB;
