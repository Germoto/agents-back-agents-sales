-- Acciones al enviar una respuesta rápida: etiquetar al cliente y/o moverlo a
-- una pestaña de un CRM. { tagIds: string[], crmId?: string, crmColumnId?: string }
ALTER TABLE "QuickReply" ADD COLUMN "actions" JSONB;
