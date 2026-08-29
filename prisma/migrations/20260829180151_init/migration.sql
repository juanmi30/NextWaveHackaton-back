-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('APPROVED', 'DECLINED', 'ERROR', 'TIMEOUT');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "merchant" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "issuingBank" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL,
    "declineCode" TEXT,
    "errorType" TEXT,
    "latencyMs" INTEGER,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "dimensions" JSONB NOT NULL,
    "severity" INTEGER NOT NULL DEFAULT 0,
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "baselineRate" DOUBLE PRECISION NOT NULL,
    "observedRate" DOUBLE PRECISION NOT NULL,
    "estimatedLoss" INTEGER NOT NULL DEFAULT 0,
    "evidence" JSONB,
    "recommendation" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Transaction_occurredAt_idx" ON "Transaction"("occurredAt");

-- CreateIndex
CREATE INDEX "Transaction_provider_country_occurredAt_idx" ON "Transaction"("provider", "country", "occurredAt");

-- CreateIndex
CREATE INDEX "Transaction_merchant_issuingBank_occurredAt_idx" ON "Transaction"("merchant", "issuingBank", "occurredAt");

-- CreateIndex
CREATE INDEX "Transaction_method_country_occurredAt_idx" ON "Transaction"("method", "country", "occurredAt");

-- CreateIndex
CREATE INDEX "Incident_status_detectedAt_idx" ON "Incident"("status", "detectedAt");

-- CreateIndex
CREATE INDEX "Incident_detectedAt_idx" ON "Incident"("detectedAt");
