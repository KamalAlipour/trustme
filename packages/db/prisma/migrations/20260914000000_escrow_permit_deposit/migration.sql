CREATE TYPE "EscrowPermitDepositStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED');

CREATE TABLE "EscrowPermitDeposit" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "walletAddress" TEXT NOT NULL,
  "amountMicroUsdt" BIGINT NOT NULL,
  "deadline" BIGINT NOT NULL,
  "v" INTEGER NOT NULL,
  "r" TEXT NOT NULL,
  "s" TEXT NOT NULL,
  "status" "EscrowPermitDepositStatus" NOT NULL DEFAULT 'PENDING',
  "chainTxHash" TEXT,
  "lastError" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmedAt" TIMESTAMP(3),
  CONSTRAINT "EscrowPermitDeposit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EscrowPermitDeposit_userId_createdAt_idx" ON "EscrowPermitDeposit"("userId", "createdAt");
CREATE INDEX "EscrowPermitDeposit_status_chainTxHash_idx" ON "EscrowPermitDeposit"("status", "chainTxHash");

ALTER TABLE "EscrowPermitDeposit"
  ADD CONSTRAINT "EscrowPermitDeposit_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
