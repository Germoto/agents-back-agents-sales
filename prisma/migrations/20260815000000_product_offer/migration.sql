-- Ofertas con vigencia por producto: precio de oferta + ventana opcional.
-- Vigente => el agente presenta/cobra/valida offerPrice y price queda como "antes".
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "offerPrice" TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "offerStartsAt" TIMESTAMP(3);
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "offerEndsAt" TIMESTAMP(3);
