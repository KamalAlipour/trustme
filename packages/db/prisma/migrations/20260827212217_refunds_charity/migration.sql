/*
  Warnings:

  - A unique constraint covering the columns `[type,charityId,asset]` on the table `LedgerAccount` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('AUDIO', 'IMAGE', 'VIDEO', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CharityAgentRole" AS ENUM ('AGENT', 'MANAGER');

-- CreateEnum
CREATE TYPE "AidRequestStatus" AS ENUM ('PENDING', 'DOCUMENTS_REQUESTED', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "LedgerAccount" ADD COLUMN     "charityId" UUID;

ALTER TABLE "LedgerAccount" DROP CONSTRAINT "LedgerAccount_asset_type_check";
ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_asset_type_check" CHECK (
  (("type" = 'USER_COUPON') AND ("asset" = 'COUPON') AND ("balance" >= 0))
  OR (("type" = 'CHARITY_COUPON') AND ("asset" = 'COUPON') AND ("balance" >= 0))
  OR (("type" = 'ESCROW') AND ("asset" = 'COUPON') AND ("balance" >= 0))
  OR (("type" = 'GUARANTEE_LOCK') AND ("asset" = 'COUPON') AND ("balance" >= 0))
  OR (("type" = 'SYSTEM_COUPON_ISSUANCE') AND ("asset" = 'COUPON') AND ("balance" <= 0))
  OR (("type" IN ('SYSTEM_VAULT_USDT', 'SYSTEM_WITHDRAWAL_PENDING', 'SYSTEM_FEE_COLLECTION')) AND ("asset" = 'USDT') AND ("balance" >= 0))
  OR (("type" = 'EXTERNAL_ONCHAIN') AND ("asset" = 'USDT'))
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "kind" "MediaKind" NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "refundRequestId" UUID,
    "aidRequestId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundRequest" (
    "id" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "buyerId" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "amountCoupons" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "decisionNote" TEXT,
    "refundTransactionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "RefundRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Charity" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "contactEmail" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Charity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CharityAgent" (
    "id" UUID NOT NULL,
    "charityId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "CharityAgentRole" NOT NULL DEFAULT 'AGENT',
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CharityAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AidRequest" (
    "id" UUID NOT NULL,
    "charityId" UUID NOT NULL,
    "applicantId" UUID NOT NULL,
    "loanId" UUID,
    "amountCoupons" BIGINT NOT NULL,
    "approvedCoupons" BIGINT,
    "description" TEXT NOT NULL,
    "status" "AidRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decisionNote" TEXT,
    "decidedById" UUID,
    "disbursementTransactionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "AidRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_storageKey_key" ON "MediaAsset"("storageKey");

-- CreateIndex
CREATE INDEX "MediaAsset_ownerId_createdAt_idx" ON "MediaAsset"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "MediaAsset_refundRequestId_idx" ON "MediaAsset"("refundRequestId");

-- CreateIndex
CREATE INDEX "MediaAsset_aidRequestId_idx" ON "MediaAsset"("aidRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "RefundRequest_refundTransactionId_key" ON "RefundRequest"("refundTransactionId");

-- CreateIndex
CREATE INDEX "RefundRequest_sellerId_status_createdAt_idx" ON "RefundRequest"("sellerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "RefundRequest_buyerId_createdAt_idx" ON "RefundRequest"("buyerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Charity_name_key" ON "Charity"("name");

-- CreateIndex
CREATE INDEX "CharityAgent_userId_revokedAt_idx" ON "CharityAgent"("userId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CharityAgent_charityId_userId_key" ON "CharityAgent"("charityId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "AidRequest_disbursementTransactionId_key" ON "AidRequest"("disbursementTransactionId");

-- CreateIndex
CREATE INDEX "AidRequest_charityId_status_createdAt_idx" ON "AidRequest"("charityId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AidRequest_applicantId_createdAt_idx" ON "AidRequest"("applicantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_type_charityId_asset_key" ON "LedgerAccount"("type", "charityId", "asset");

CREATE UNIQUE INDEX "RefundRequest_one_pending_per_transaction"
ON "RefundRequest"("transactionId")
WHERE "status" = 'PENDING';

ALTER TABLE "LedgerAccount" ADD CONSTRAINT "ledger_account_owner_ck" CHECK (
  ("type" = 'USER_COUPON' AND "userId" IS NOT NULL AND "charityId" IS NULL)
  OR ("type" = 'CHARITY_COUPON' AND "charityId" IS NOT NULL AND "userId" IS NULL)
  OR ("type" NOT IN ('USER_COUPON', 'CHARITY_COUPON'))
);

-- AddForeignKey
ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_charityId_fkey" FOREIGN KEY ("charityId") REFERENCES "Charity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_refundRequestId_fkey" FOREIGN KEY ("refundRequestId") REFERENCES "RefundRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_aidRequestId_fkey" FOREIGN KEY ("aidRequestId") REFERENCES "AidRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_refundTransactionId_fkey" FOREIGN KEY ("refundTransactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CharityAgent" ADD CONSTRAINT "CharityAgent_charityId_fkey" FOREIGN KEY ("charityId") REFERENCES "Charity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CharityAgent" ADD CONSTRAINT "CharityAgent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AidRequest" ADD CONSTRAINT "AidRequest_charityId_fkey" FOREIGN KEY ("charityId") REFERENCES "Charity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AidRequest" ADD CONSTRAINT "AidRequest_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AidRequest" ADD CONSTRAINT "AidRequest_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AidRequest" ADD CONSTRAINT "AidRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AidRequest" ADD CONSTRAINT "AidRequest_disbursementTransactionId_fkey" FOREIGN KEY ("disbursementTransactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
