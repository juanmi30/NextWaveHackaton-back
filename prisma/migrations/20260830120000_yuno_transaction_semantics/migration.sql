-- Semantica Yuno v2 sobre Transaction.
-- Estrictamente ADITIVA: todas las columnas son opcionales y ningun modulo
-- existente cambia de comportamiento. No borra ni renombra nada.

ALTER TABLE "Transaction" ADD COLUMN "paymentId" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "attemptNumber" INTEGER DEFAULT 1;
ALTER TABLE "Transaction" ADD COLUMN "transactionType" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "yunoStatus" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "responseCode" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "merchantAdviceCode" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "providerResponseCode" TEXT;

CREATE INDEX "Transaction_responseCode_occurredAt_idx" ON "Transaction"("responseCode", "occurredAt");
CREATE INDEX "Transaction_yunoStatus_occurredAt_idx" ON "Transaction"("yunoStatus", "occurredAt");
CREATE INDEX "Transaction_paymentId_idx" ON "Transaction"("paymentId");
