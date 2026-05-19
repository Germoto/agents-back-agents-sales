-- Add AUDIO to ProductFileType enum
ALTER TYPE "ProductFileType" ADD VALUE IF NOT EXISTS 'AUDIO';

-- Extend ProductFile with local storage metadata
ALTER TABLE "ProductFile"
  ADD COLUMN IF NOT EXISTS "storagePath" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "originalName" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "extension" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "mimeType" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "size" INTEGER NOT NULL DEFAULT 0;

-- Make description optional (with default empty string)
ALTER TABLE "ProductFile" ALTER COLUMN "description" SET DEFAULT '';
