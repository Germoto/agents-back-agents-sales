-- Mensaje de presentación configurable (el bot lo envía tal cual al presentar el producto).
ALTER TABLE "Product"
  ADD COLUMN "presentationMessage" TEXT;
