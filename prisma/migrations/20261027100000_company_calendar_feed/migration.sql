-- Feed ICS secreto por empresa (calendario suscrito del dueño). Aditivo, sin backfill.
CREATE TABLE IF NOT EXISTS "CompanyCalendarFeed" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "companyId" UUID NOT NULL,
  "token" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CompanyCalendarFeed_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "CompanyCalendarFeed_companyId_key" ON "CompanyCalendarFeed"("companyId");
CREATE UNIQUE INDEX IF NOT EXISTS "CompanyCalendarFeed_token_key" ON "CompanyCalendarFeed"("token");
ALTER TABLE "CompanyCalendarFeed" DROP CONSTRAINT IF EXISTS "CompanyCalendarFeed_companyId_fkey";
ALTER TABLE "CompanyCalendarFeed" ADD CONSTRAINT "CompanyCalendarFeed_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
