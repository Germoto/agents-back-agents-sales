-- Moneda del negocio (nivel EMPRESA). Aditiva: el default PEN cubre a todos
-- los tenants existentes sin backfill.
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'PEN';
