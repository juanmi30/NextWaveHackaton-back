/*
  Warnings:

  - You are about to drop the column `baselineRate` on the `Incident` table. All the data in the column will be lost.
  - You are about to drop the column `dimensions` on the `Incident` table. All the data in the column will be lost.
  - You are about to drop the column `estimatedLoss` on the `Incident` table. All the data in the column will be lost.
  - You are about to drop the column `evidence` on the `Incident` table. All the data in the column will be lost.
  - You are about to drop the column `observedRate` on the `Incident` table. All the data in the column will be lost.
  - You are about to drop the column `title` on the `Incident` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[externalId]` on the table `Transaction` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `anchorFingerprint` to the `Incident` table without a default value. This is not possible if the table is not empty.
  - Added the required column `detectionRunId` to the `Incident` table without a default value. This is not possible if the table is not empty.
  - Added the required column `fingerprint` to the `Incident` table without a default value. This is not possible if the table is not empty.
  - Added the required column `startedAt` to the `Incident` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "DetectionOutcome" AS ENUM ('NO_ANOMALY', 'INSUFFICIENT_EVIDENCE', 'INCIDENTS_FOUND');

-- AlterTable
ALTER TABLE "Incident" DROP COLUMN "baselineRate",
DROP COLUMN "dimensions",
DROP COLUMN "estimatedLoss",
DROP COLUMN "evidence",
DROP COLUMN "observedRate",
DROP COLUMN "title",
ADD COLUMN     "actualApprovals" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "anchorFingerprint" TEXT NOT NULL,
ADD COLUMN     "averageTicketCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "confidenceStatement" TEXT,
ADD COLUMN     "detectionRunId" TEXT NOT NULL,
ADD COLUMN     "expectedApprovals" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "fingerprint" TEXT NOT NULL,
ADD COLUMN     "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "lossPerMinuteCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lostApprovals" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "startedAt" TIMESTAMPTZ(3) NOT NULL,
ADD COLUMN     "summaryExec" TEXT,
ADD COLUMN     "summaryOps" TEXT,
ALTER COLUMN "detectedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "resolvedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "amountUsdCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "fxRateId" TEXT,
ALTER COLUMN "occurredAt" SET DATA TYPE TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "FxRate" (
    "id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "rateDate" DATE NOT NULL,
    "usdPerUnit" DECIMAL(18,8) NOT NULL,
    "source" TEXT,

    CONSTRAINT "FxRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Baseline" (
    "id" TEXT NOT NULL,
    "dimensionKey" TEXT NOT NULL,
    "segmentKey" TEXT NOT NULL,
    "segment" JSONB NOT NULL,
    "hourOfDay" INTEGER NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "expectedRate" DOUBLE PRECISION NOT NULL,
    "variance" DOUBLE PRECISION NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "calculatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Baseline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DetectionRun" (
    "id" TEXT NOT NULL,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "windowEnd" TIMESTAMPTZ(3) NOT NULL,
    "baselineStart" TIMESTAMPTZ(3) NOT NULL,
    "baselineEnd" TIMESTAMPTZ(3) NOT NULL,
    "params" JSONB NOT NULL,
    "combosEvaluated" INTEGER NOT NULL DEFAULT 0,
    "outcome" "DetectionOutcome" NOT NULL,
    "durationMs" INTEGER,
    "finishedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DetectionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentDiagnosis" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "detectionRunId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "dimensions" JSONB NOT NULL,
    "dimensionDepth" INTEGER NOT NULL,
    "baselineRate" DOUBLE PRECISION NOT NULL,
    "observedRate" DOUBLE PRECISION NOT NULL,
    "baselineAttempts" INTEGER NOT NULL,
    "observedAttempts" INTEGER NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "sampleTransactionIds" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentDiagnosis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiagnosisEvidence" (
    "id" TEXT NOT NULL,
    "diagnosisId" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "dimensionValue" TEXT NOT NULL,
    "baselineRate" DOUBLE PRECISION NOT NULL,
    "observedRate" DOUBLE PRECISION NOT NULL,
    "difference" DOUBLE PRECISION NOT NULL,
    "attempts" INTEGER NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "isRootCause" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "DiagnosisEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FxRate_currency_rateDate_key" ON "FxRate"("currency", "rateDate");

-- CreateIndex
CREATE INDEX "Baseline_dimensionKey_segmentKey_idx" ON "Baseline"("dimensionKey", "segmentKey");

-- CreateIndex
CREATE UNIQUE INDEX "Baseline_dimensionKey_segmentKey_hourOfDay_dayOfWeek_key" ON "Baseline"("dimensionKey", "segmentKey", "hourOfDay", "dayOfWeek");

-- CreateIndex
CREATE INDEX "DetectionRun_finishedAt_idx" ON "DetectionRun"("finishedAt");

-- CreateIndex
CREATE INDEX "DetectionRun_outcome_finishedAt_idx" ON "DetectionRun"("outcome", "finishedAt");

-- CreateIndex
CREATE INDEX "IncidentDiagnosis_fingerprint_idx" ON "IncidentDiagnosis"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "IncidentDiagnosis_incidentId_version_key" ON "IncidentDiagnosis"("incidentId", "version");

-- CreateIndex
CREATE INDEX "DiagnosisEvidence_diagnosisId_idx" ON "DiagnosisEvidence"("diagnosisId");

-- CreateIndex
CREATE INDEX "DiagnosisEvidence_diagnosisId_isRootCause_idx" ON "DiagnosisEvidence"("diagnosisId", "isRootCause");

-- CreateIndex
CREATE INDEX "Incident_anchorFingerprint_idx" ON "Incident"("anchorFingerprint");

-- CreateIndex
CREATE INDEX "Incident_fingerprint_idx" ON "Incident"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_externalId_key" ON "Transaction"("externalId");

-- CreateIndex
CREATE INDEX "Transaction_failureReason_occurredAt_idx" ON "Transaction"("failureReason", "occurredAt");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_fxRateId_fkey" FOREIGN KEY ("fxRateId") REFERENCES "FxRate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_detectionRunId_fkey" FOREIGN KEY ("detectionRunId") REFERENCES "DetectionRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentDiagnosis" ADD CONSTRAINT "IncidentDiagnosis_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentDiagnosis" ADD CONSTRAINT "IncidentDiagnosis_detectionRunId_fkey" FOREIGN KEY ("detectionRunId") REFERENCES "DetectionRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosisEvidence" ADD CONSTRAINT "DiagnosisEvidence_diagnosisId_fkey" FOREIGN KEY ("diagnosisId") REFERENCES "IncidentDiagnosis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
