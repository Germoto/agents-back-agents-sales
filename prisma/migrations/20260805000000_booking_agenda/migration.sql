-- Agenda de citas real (rubro SERVICE): horario de atención, slots y recordatorios

-- AlterEnum: recordatorio de cita (exento de los guards de seguimiento)
ALTER TYPE "ScheduledMessageType" ADD VALUE IF NOT EXISTS 'BOOKING_REMINDER';

-- AlterTable: horario de atención del negocio
ALTER TABLE "Company" ADD COLUMN "businessHours" JSONB;

-- AlterTable: datos tipados del servicio para el motor de disponibilidad
ALTER TABLE "Product" ADD COLUMN "durationMin" INTEGER;
ALTER TABLE "Product" ADD COLUMN "slotCapacity" INTEGER DEFAULT 1;
ALTER TABLE "Product" ADD COLUMN "bookingLeadMinutes" INTEGER;
ALTER TABLE "Product" ADD COLUMN "bookingHorizonDays" INTEGER;

-- AlterTable: la reserva pasa a ser una CITA con fecha y hora
ALTER TABLE "ServiceBooking" ADD COLUMN "startsAt" TIMESTAMP(3);
ALTER TABLE "ServiceBooking" ADD COLUMN "endsAt" TIMESTAMP(3);
ALTER TABLE "ServiceBooking" ADD COLUMN "durationMin" INTEGER;
ALTER TABLE "ServiceBooking" ADD COLUMN "bookingCode" TEXT;
ALTER TABLE "ServiceBooking" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'agent';
ALTER TABLE "ServiceBooking" ADD COLUMN "cancelToken" TEXT;

CREATE UNIQUE INDEX "ServiceBooking_bookingCode_key" ON "ServiceBooking"("bookingCode");
CREATE INDEX "ServiceBooking_companyId_startsAt_idx" ON "ServiceBooking"("companyId", "startsAt");

-- CreateTable: bloqueos de agenda (feriados, vacaciones)
CREATE TABLE "ScheduleBlock" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "companyId" UUID NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleBlock_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ScheduleBlock_companyId_startsAt_idx" ON "ScheduleBlock"("companyId", "startsAt");

ALTER TABLE "ScheduleBlock" ADD CONSTRAINT "ScheduleBlock_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
