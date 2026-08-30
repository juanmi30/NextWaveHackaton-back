-- CreateEnum
CREATE TYPE "RecipientRole" AS ENUM ('CHECKOUT_ENGINEER', 'INTEGRATIONS_ENGINEER', 'PROVIDER_MANAGER', 'RISK_ANALYST', 'MERCHANT_SUCCESS', 'PAYMENTS_OPS', 'ADMIN');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'WHATSAPP', 'CONSOLE');

-- CreateEnum
CREATE TYPE "EscalationStatus" AS ENUM ('PENDING', 'ACKNOWLEDGED', 'RESOLVED', 'EXHAUSTED');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('SENT', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "Recipient" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "role" "RecipientRole" NOT NULL,
    "merchants" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "providers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Recipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EscalationPolicy" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "minSeverity" INTEGER NOT NULL DEFAULT 0,
    "maxSeverity" INTEGER NOT NULL DEFAULT 5,

    CONSTRAINT "EscalationPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EscalationStep" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "waitMinutes" INTEGER NOT NULL DEFAULT 0,
    "label" TEXT NOT NULL,
    "roles" "RecipientRole"[] DEFAULT ARRAY[]::"RecipientRole"[],
    "includeSpecialists" BOOLEAN NOT NULL DEFAULT true,
    "channels" "NotificationChannel"[] DEFAULT ARRAY[]::"NotificationChannel"[],

    CONSTRAINT "EscalationStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentEscalation" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "status" "EscalationStatus" NOT NULL DEFAULT 'PENDING',
    "currentLevel" INTEGER NOT NULL DEFAULT 0,
    "category" TEXT,
    "actionability" TEXT,
    "routedRoles" "RecipientRole"[] DEFAULT ARRAY[]::"RecipientRole"[],
    "routingReason" TEXT,
    "nextEscalationAt" TIMESTAMPTZ(3),
    "acknowledgedAt" TIMESTAMPTZ(3),
    "acknowledgedById" TEXT,
    "closedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentEscalation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertNotification" (
    "id" TEXT NOT NULL,
    "escalationId" TEXT NOT NULL,
    "recipientId" TEXT,
    "level" INTEGER NOT NULL,
    "role" "RecipientRole",
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationStatus" NOT NULL,
    "target" TEXT,
    "error" TEXT,
    "sentAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Recipient_role_active_idx" ON "Recipient"("role", "active");

-- CreateIndex
CREATE UNIQUE INDEX "EscalationPolicy_name_key" ON "EscalationPolicy"("name");

-- CreateIndex
CREATE UNIQUE INDEX "EscalationStep_policyId_level_key" ON "EscalationStep"("policyId", "level");

-- CreateIndex
CREATE UNIQUE INDEX "IncidentEscalation_incidentId_key" ON "IncidentEscalation"("incidentId");

-- CreateIndex
CREATE INDEX "IncidentEscalation_status_nextEscalationAt_idx" ON "IncidentEscalation"("status", "nextEscalationAt");

-- CreateIndex
CREATE INDEX "AlertNotification_escalationId_level_idx" ON "AlertNotification"("escalationId", "level");

-- AddForeignKey
ALTER TABLE "EscalationStep" ADD CONSTRAINT "EscalationStep_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "EscalationPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentEscalation" ADD CONSTRAINT "IncidentEscalation_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentEscalation" ADD CONSTRAINT "IncidentEscalation_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "EscalationPolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentEscalation" ADD CONSTRAINT "IncidentEscalation_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "Recipient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertNotification" ADD CONSTRAINT "AlertNotification_escalationId_fkey" FOREIGN KEY ("escalationId") REFERENCES "IncidentEscalation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertNotification" ADD CONSTRAINT "AlertNotification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Recipient"("id") ON DELETE SET NULL ON UPDATE CASCADE;
