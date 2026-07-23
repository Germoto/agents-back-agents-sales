-- CreateIndex: board/embudo del CRM suman comprobantes APROBADOS por customerId
CREATE INDEX "PaymentReceipt_companyId_status_customerId_idx" ON "PaymentReceipt"("companyId", "status", "customerId");
