-- AlterTable: derivar a un asesor humano cuando el cliente pide rebaja
ALTER TABLE "AgentConfig" ADD COLUMN "negotiationHandoff" BOOLEAN NOT NULL DEFAULT false;
