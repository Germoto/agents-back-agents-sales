-- Pack Servicios: reservas ligeras de servicios.
CREATE TYPE "ServiceBookingStatus" AS ENUM ('SOLICITADA', 'CONFIRMADA', 'CANCELADA', 'COMPLETADA');

CREATE TABLE "ServiceBooking" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "requestedText" TEXT NOT NULL,
    "modality" TEXT,
    "status" "ServiceBookingStatus" NOT NULL DEFAULT 'SOLICITADA',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceBooking_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ServiceBooking_companyId_createdAt_idx" ON "ServiceBooking"("companyId", "createdAt");

ALTER TABLE "ServiceBooking" ADD CONSTRAINT "ServiceBooking_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceBooking" ADD CONSTRAINT "ServiceBooking_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceBooking" ADD CONSTRAINT "ServiceBooking_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
