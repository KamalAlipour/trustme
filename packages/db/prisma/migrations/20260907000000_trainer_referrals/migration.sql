-- CreateEnum
CREATE TYPE "CommissionPayoutRole" AS ENUM ('BUYER_MARKETER', 'SELLER_MARKETER', 'TRAINER');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "trainerId" UUID;

-- CreateTable
CREATE TABLE "CommissionPayout" (
    "id" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "sourceUserId" UUID NOT NULL,
    "role" "CommissionPayoutRole" NOT NULL,
    "amount" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionPayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommissionPayout_recipientId_role_idx" ON "CommissionPayout"("recipientId", "role");

-- CreateIndex
CREATE INDEX "CommissionPayout_transactionId_idx" ON "CommissionPayout"("transactionId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_trainerId_fkey"
  FOREIGN KEY ("trainerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionPayout" ADD CONSTRAINT "CommissionPayout_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionPayout" ADD CONSTRAINT "CommissionPayout_recipientId_fkey"
  FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionPayout" ADD CONSTRAINT "CommissionPayout_sourceUserId_fkey"
  FOREIGN KEY ("sourceUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
