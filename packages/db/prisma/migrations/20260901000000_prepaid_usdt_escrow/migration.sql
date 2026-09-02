CREATE TYPE "MemberWalletKind" AS ENUM ('EXTERNAL', 'IN_APP', 'SMART_ACCOUNT');
CREATE TYPE "EscrowEventKind" AS ENUM ('DEPOSIT', 'SETTLE', 'UNLOAD');
CREATE TYPE "PayCodeStatus" AS ENUM ('ACTIVE', 'USED', 'EXPIRED', 'CANCELLED');
CREATE TYPE "EscrowSettlementStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED');
CREATE TYPE "EscrowUnloadStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED');

CREATE TABLE "MemberWallet" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "kind" "MemberWalletKind" NOT NULL,
    "chainId" INTEGER NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MemberWallet_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MemberWallet_address_key" ON "MemberWallet"("address");
CREATE INDEX "MemberWallet_userId_idx" ON "MemberWallet"("userId");
ALTER TABLE "MemberWallet" ADD CONSTRAINT "MemberWallet_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EscrowBalance" (
    "userId" UUID NOT NULL,
    "lockedMicroUsdt" BIGINT NOT NULL DEFAULT 0,
    "reservedMicroUsdt" BIGINT NOT NULL DEFAULT 0,
    "lastEventAt" TIMESTAMP(3),
    CONSTRAINT "EscrowBalance_pkey" PRIMARY KEY ("userId")
);
ALTER TABLE "EscrowBalance" ADD CONSTRAINT "EscrowBalance_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EscrowChainEvent" (
    "id" UUID NOT NULL,
    "kind" "EscrowEventKind" NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "amountMicroUsdt" BIGINT NOT NULL,
    "ref" TEXT,
    "userId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EscrowChainEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EscrowChainEvent_txHash_logIndex_key" ON "EscrowChainEvent"("txHash", "logIndex");
CREATE INDEX "EscrowChainEvent_walletAddress_idx" ON "EscrowChainEvent"("walletAddress");
ALTER TABLE "EscrowChainEvent" ADD CONSTRAINT "EscrowChainEvent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "PayCode" (
    "id" UUID NOT NULL,
    "buyerId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "maxAmountMicroUsdt" BIGINT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "PayCodeStatus" NOT NULL DEFAULT 'ACTIVE',
    "wrongAttempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),
    CONSTRAINT "PayCode_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PayCode_buyerId_status_idx" ON "PayCode"("buyerId", "status");
CREATE INDEX "PayCode_expiresAt_status_idx" ON "PayCode"("expiresAt", "status");
ALTER TABLE "PayCode" ADD CONSTRAINT "PayCode_buyerId_fkey"
  FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EscrowSettlement" (
    "id" UUID NOT NULL,
    "buyerId" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "payCodeId" UUID NOT NULL,
    "amountMicroUsdt" BIGINT NOT NULL,
    "ref" TEXT NOT NULL,
    "status" "EscrowSettlementStatus" NOT NULL DEFAULT 'PENDING',
    "transactionId" UUID,
    "chainTxHash" TEXT,
    "lastError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    CONSTRAINT "EscrowSettlement_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EscrowSettlement_payCodeId_key" ON "EscrowSettlement"("payCodeId");
CREATE UNIQUE INDEX "EscrowSettlement_ref_key" ON "EscrowSettlement"("ref");
CREATE UNIQUE INDEX "EscrowSettlement_transactionId_key" ON "EscrowSettlement"("transactionId");
ALTER TABLE "EscrowSettlement" ADD CONSTRAINT "EscrowSettlement_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EscrowSettlement" ADD CONSTRAINT "EscrowSettlement_buyerId_fkey"
  FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EscrowSettlement" ADD CONSTRAINT "EscrowSettlement_merchantId_fkey"
  FOREIGN KEY ("merchantId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EscrowUnload" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "amountMicroUsdt" BIGINT NOT NULL,
    "ref" TEXT NOT NULL,
    "status" "EscrowUnloadStatus" NOT NULL DEFAULT 'PENDING',
    "chainTxHash" TEXT,
    "lastError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    CONSTRAINT "EscrowUnload_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EscrowUnload_ref_key" ON "EscrowUnload"("ref");
ALTER TABLE "EscrowUnload" ADD CONSTRAINT "EscrowUnload_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
