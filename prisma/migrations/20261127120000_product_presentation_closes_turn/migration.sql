-- Ficha con cierre propio (aditivo): tras la ficha el agente no agrega texto.
-- Apagado por defecto: ningún producto cambia de comportamiento.
ALTER TABLE "Product" ADD COLUMN "presentationClosesTurn" BOOLEAN NOT NULL DEFAULT false;
