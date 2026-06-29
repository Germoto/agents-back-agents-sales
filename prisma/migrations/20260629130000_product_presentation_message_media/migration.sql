-- Multimedia opcional de la info completa de presentación. Se envía con
-- presentationMessage como caption, en un solo mensaje. Vacío => solo texto.
ALTER TABLE "Product"
  ADD COLUMN "presentationMessageMediaUrl" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "presentationMessageMediaType" TEXT NOT NULL DEFAULT '';
