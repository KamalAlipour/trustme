-- CreateEnum
CREATE TYPE "LoanStatus" AS ENUM ('REQUESTED', 'ACTIVE', 'SETTLED', 'DEFAULTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GuaranteeStatus" AS ENUM ('PENDING', 'CONFIRMATION_PENDING', 'CODE_LOCKED', 'ACTIVE', 'RELEASED', 'CLAIMED', 'DECLINED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "AccountType" ADD VALUE 'GUARANTEE_LOCK';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TransactionType" ADD VALUE 'GUARANTEE_LOCK';
ALTER TYPE "TransactionType" ADD VALUE 'GUARANTEE_RELEASE';
ALTER TYPE "TransactionType" ADD VALUE 'GUARANTEE_CLAIM';
ALTER TYPE "TransactionType" ADD VALUE 'LOAN_DISBURSE';
ALTER TYPE "TransactionType" ADD VALUE 'LOAN_REPAY';

-- AlterTable
ALTER TABLE "AdminAuditLog" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "AdminUser" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ChainCursor" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "DepositAddress" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "EscrowHold" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "LedgerAccount" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "LedgerEntry" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "SystemSetting" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Transaction" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "activeGuaranteeCount" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Withdrawal" ADD COLUMN     "eligibleAt" TIMESTAMP(3);
UPDATE "Withdrawal" SET "eligibleAt" = "createdAt" WHERE "eligibleAt" IS NULL;
ALTER TABLE "Withdrawal" ALTER COLUMN "eligibleAt" SET NOT NULL,
ALTER COLUMN "id" DROP DEFAULT;

-- CreateTable
CREATE TABLE "Loan" (
    "id" UUID NOT NULL,
    "borrowerId" UUID NOT NULL,
    "lenderId" UUID,
    "principalCoupons" BIGINT NOT NULL,
    "outstandingCoupons" BIGINT NOT NULL DEFAULT 0,
    "status" "LoanStatus" NOT NULL DEFAULT 'REQUESTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fundedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "disbursementTransactionId" UUID,

    CONSTRAINT "Loan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanInstallment" (
    "id" UUID NOT NULL,
    "loanId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "amountCoupons" BIGINT NOT NULL,
    "paidCoupons" BIGINT NOT NULL DEFAULT 0,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "LoanInstallment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Guarantee" (
    "id" UUID NOT NULL,
    "loanId" UUID NOT NULL,
    "guarantorId" UUID NOT NULL,
    "amountCoupons" BIGINT NOT NULL,
    "codeHash" TEXT,
    "wrongAttempts" INTEGER NOT NULL DEFAULT 0,
    "status" "GuaranteeStatus" NOT NULL DEFAULT 'PENDING',
    "lockTransactionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Guarantee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Loan_disbursementTransactionId_key" ON "Loan"("disbursementTransactionId");

-- CreateIndex
CREATE INDEX "Loan_borrowerId_status_idx" ON "Loan"("borrowerId", "status");

-- CreateIndex
CREATE INDEX "Loan_lenderId_status_idx" ON "Loan"("lenderId", "status");

-- CreateIndex
CREATE INDEX "LoanInstallment_loanId_dueAt_idx" ON "LoanInstallment"("loanId", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "LoanInstallment_loanId_sequence_key" ON "LoanInstallment"("loanId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "Guarantee_lockTransactionId_key" ON "Guarantee"("lockTransactionId");

-- CreateIndex
CREATE INDEX "Guarantee_guarantorId_status_idx" ON "Guarantee"("guarantorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Guarantee_loanId_guarantorId_key" ON "Guarantee"("loanId", "guarantorId");

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_borrowerId_fkey" FOREIGN KEY ("borrowerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_lenderId_fkey" FOREIGN KEY ("lenderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_disbursementTransactionId_fkey" FOREIGN KEY ("disbursementTransactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanInstallment" ADD CONSTRAINT "LoanInstallment_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Guarantee" ADD CONSTRAINT "Guarantee_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Guarantee" ADD CONSTRAINT "Guarantee_guarantorId_fkey" FOREIGN KEY ("guarantorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Guarantee" ADD CONSTRAINT "Guarantee_lockTransactionId_fkey" FOREIGN KEY ("lockTransactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
