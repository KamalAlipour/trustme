-- CreateEnum
CREATE TYPE "DepositSweepStatus" AS ENUM ('PENDING', 'GAS_FUNDING', 'BROADCAST', 'CONFIRMED', 'FAILED');

-- AlterTable
ALTER TABLE "DepositAddress" ADD COLUMN     "sweepPendingAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DepositSweep" (
    "id" UUID NOT NULL,
    "depositAddressId" UUID NOT NULL,
    "amountMicroUsdt" BIGINT NOT NULL,
    "gasTxHash" TEXT,
    "sweepTxHash" TEXT,
    "status" "DepositSweepStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "DepositSweep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DepositSweep_sweepTxHash_key" ON "DepositSweep"("sweepTxHash");

-- CreateIndex
CREATE INDEX "DepositSweep_depositAddressId_idx" ON "DepositSweep"("depositAddressId");

-- CreateIndex
CREATE INDEX "DepositAddress_sweepPendingAt_idx" ON "DepositAddress"("sweepPendingAt");

-- AddForeignKey
ALTER TABLE "DepositSweep" ADD CONSTRAINT "DepositSweep_depositAddressId_fkey" FOREIGN KEY ("depositAddressId") REFERENCES "DepositAddress"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
