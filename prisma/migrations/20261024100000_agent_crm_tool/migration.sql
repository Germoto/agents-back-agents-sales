-- Herramienta de CRM del agente IA (actualizar_crm): lista blanca de columnas/etiquetas con reglas "cuándo". null = apagada.
ALTER TABLE "AgentConfig" ADD COLUMN IF NOT EXISTS "crmToolConfig" JSONB;
