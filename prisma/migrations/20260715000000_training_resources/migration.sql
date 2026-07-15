-- CreateEnum
CREATE TYPE "TrainingResourceType" AS ENUM ('PDF', 'VIDEO', 'YOUTUBE', 'LINK');

-- CreateTable
CREATE TABLE "TrainingResource" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" "TrainingResourceType" NOT NULL,
    "url" TEXT,
    "storagePath" TEXT,
    "mimeType" TEXT,
    "size" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingResource_pkey" PRIMARY KEY ("id")
);
