-- CreateEnum
CREATE TYPE "PurchaseGuaranteeStatus" AS ENUM ('ACTIVE', 'EXHAUSTED', 'REVOKED');

-- AlterEnum
ALTER TYPE "AidRequestStatus" ADD VALUE 'GUARANTEED';

-- DropForeignKey
ALTER TABLE "EscrowBalance" DROP CONSTRAINT "EscrowBalance_userId_fkey";

-- DropForeignKey
ALTER TABLE "EscrowSettlement" DROP CONSTRAINT "EscrowSettlement_buyerId_fkey";

-- DropForeignKey
ALTER TABLE "EscrowSettlement" DROP CONSTRAINT "EscrowSettlement_merchantId_fkey";

-- DropForeignKey
ALTER TABLE "EscrowUnload" DROP CONSTRAINT "EscrowUnload_userId_fkey";

-- DropForeignKey
ALTER TABLE "MemberWallet" DROP CONSTRAINT "MemberWallet_userId_fkey";

-- DropForeignKey
ALTER TABLE "PayCode" DROP CONSTRAINT "PayCode_buyerId_fkey";

-- AlterTable
ALTER TABLE "EscrowSettlement" ADD COLUMN     "guaranteeId" UUID,
ADD COLUMN     "payerId" UUID;

UPDATE "EscrowSettlement" SET "payerId" = "buyerId";

ALTER TABLE "EscrowSettlement" ALTER COLUMN "payerId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PayCode" ADD COLUMN     "guaranteeId" UUID;

-- CreateTable
CREATE TABLE "PurchaseGuarantee" (
    "id" UUID NOT NULL,
    "charityId" UUID NOT NULL,
    "guarantorId" UUID NOT NULL,
    "beneficiaryId" UUID NOT NULL,
    "aidRequestId" UUID,
    "amountMicroUsdt" BIGINT NOT NULL,
    "remainingMicroUsdt" BIGINT NOT NULL,
    "status" "PurchaseGuaranteeStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "PurchaseGuarantee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseGuarantee_aidRequestId_key" ON "PurchaseGuarantee"("aidRequestId");

-- CreateIndex
CREATE INDEX "PurchaseGuarantee_beneficiaryId_status_idx" ON "PurchaseGuarantee"("beneficiaryId", "status");

-- CreateIndex
CREATE INDEX "PurchaseGuarantee_guarantorId_status_idx" ON "PurchaseGuarantee"("guarantorId", "status");

-- AddForeignKey
ALTER TABLE "MemberWallet" ADD CONSTRAINT "MemberWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowBalance" ADD CONSTRAINT "EscrowBalance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayCode" ADD CONSTRAINT "PayCode_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayCode" ADD CONSTRAINT "PayCode_guaranteeId_fkey" FOREIGN KEY ("guaranteeId") REFERENCES "PurchaseGuarantee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowSettlement" ADD CONSTRAINT "EscrowSettlement_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowSettlement" ADD CONSTRAINT "EscrowSettlement_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowSettlement" ADD CONSTRAINT "EscrowSettlement_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowSettlement" ADD CONSTRAINT "EscrowSettlement_guaranteeId_fkey" FOREIGN KEY ("guaranteeId") REFERENCES "PurchaseGuarantee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowUnload" ADD CONSTRAINT "EscrowUnload_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseGuarantee" ADD CONSTRAINT "PurchaseGuarantee_charityId_fkey" FOREIGN KEY ("charityId") REFERENCES "Charity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseGuarantee" ADD CONSTRAINT "PurchaseGuarantee_guarantorId_fkey" FOREIGN KEY ("guarantorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseGuarantee" ADD CONSTRAINT "PurchaseGuarantee_beneficiaryId_fkey" FOREIGN KEY ("beneficiaryId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseGuarantee" ADD CONSTRAINT "PurchaseGuarantee_aidRequestId_fkey" FOREIGN KEY ("aidRequestId") REFERENCES "AidRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
