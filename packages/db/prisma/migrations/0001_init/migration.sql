CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE SEQUENCE "deposit_derivation_index_seq" AS INTEGER MINVALUE 0 START WITH 0;

CREATE TYPE "Asset" AS ENUM ('USDT', 'COUPON');
CREATE TYPE "AccountType" AS ENUM ('USER_COUPON', 'ESCROW', 'SYSTEM_COUPON_ISSUANCE', 'SYSTEM_VAULT_USDT', 'SYSTEM_WITHDRAWAL_PENDING', 'SYSTEM_FEE_COLLECTION', 'EXTERNAL_ONCHAIN');
CREATE TYPE "TransactionType" AS ENUM ('DEPOSIT', 'TRANSFER', 'ESCROW_HOLD', 'ESCROW_RELEASE', 'ESCROW_CANCEL', 'WITHDRAWAL', 'REFUND', 'FEE');
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'APPROVED', 'PENDING_APPROVAL', 'PROCESSING', 'COMPLETED', 'FAILED', 'REFUNDED', 'CANCELLED');
CREATE TYPE "EscrowStatus" AS ENUM ('ACTIVE', 'RELEASED', 'CANCELLED', 'EXPIRED', 'LOCKED');
CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'PROCESSING', 'COMPLETED', 'FAILED', 'REFUNDED');
CREATE TYPE "AdminRole" AS ENUM ('VIEWER', 'APPROVER', 'ADMIN');

CREATE TABLE "User" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "phoneNumber" TEXT NOT NULL, "barcodeId" TEXT NOT NULL,
  "aliasName" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "DepositAddress" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "userId" UUID NOT NULL, "derivationIndex" INTEGER NOT NULL DEFAULT nextval('"deposit_derivation_index_seq"'),
  "address" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DepositAddress_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "LedgerAccount" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "type" "AccountType" NOT NULL, "asset" "Asset" NOT NULL,
  "userId" UUID, "balance" BIGINT NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LedgerAccount_asset_type_check" CHECK (
    ("type" = 'USER_COUPON' AND "asset" = 'COUPON' AND "balance" >= 0) OR
    ("type" = 'ESCROW' AND "asset" = 'COUPON' AND "balance" >= 0) OR
    ("type" = 'SYSTEM_COUPON_ISSUANCE' AND "asset" = 'COUPON' AND "balance" <= 0) OR
    ("type" IN ('SYSTEM_VAULT_USDT', 'SYSTEM_WITHDRAWAL_PENDING', 'SYSTEM_FEE_COLLECTION') AND "asset" = 'USDT' AND "balance" >= 0) OR
    ("type" = 'EXTERNAL_ONCHAIN' AND "asset" = 'USDT')
  )
);
CREATE TABLE "Transaction" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "userId" UUID, "type" "TransactionType" NOT NULL,
  "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING', "amountMicroUsdt" BIGINT NOT NULL DEFAULT 0,
  "amountCoupons" BIGINT NOT NULL DEFAULT 0, "feeMicroUsdt" BIGINT NOT NULL DEFAULT 0,
  "roundingDustMicroUsdt" BIGINT NOT NULL DEFAULT 0, "txHash" TEXT, "externalRef" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Transaction_nonnegative_amounts_check" CHECK ("amountMicroUsdt" >= 0 AND "amountCoupons" >= 0 AND "feeMicroUsdt" >= 0 AND "roundingDustMicroUsdt" >= 0)
);
CREATE TABLE "LedgerEntry" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "transactionId" UUID NOT NULL, "fromAccountId" UUID NOT NULL,
  "toAccountId" UUID NOT NULL, "amount" BIGINT NOT NULL, "asset" "Asset" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LedgerEntry_amount_check" CHECK ("amount" > 0), CONSTRAINT "LedgerEntry_distinct_accounts_check" CHECK ("fromAccountId" <> "toAccountId")
);
CREATE TABLE "SystemSetting" ("key" TEXT NOT NULL, "value" TEXT NOT NULL, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key"));
CREATE TABLE "EscrowHold" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "senderId" UUID NOT NULL, "recipientId" UUID NOT NULL,
  "escrowAccountId" UUID NOT NULL, "transactionId" UUID NOT NULL, "amountCoupons" BIGINT NOT NULL,
  "codeHash" TEXT NOT NULL, "wrongAttempts" INTEGER NOT NULL DEFAULT 0, "expiresAt" TIMESTAMP(3) NOT NULL,
  "status" "EscrowStatus" NOT NULL DEFAULT 'ACTIVE', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EscrowHold_pkey" PRIMARY KEY ("id"), CONSTRAINT "EscrowHold_amount_check" CHECK ("amountCoupons" > 0)
);
CREATE TABLE "Withdrawal" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "userId" UUID NOT NULL, "transactionId" UUID NOT NULL,
  "destinationAddress" TEXT NOT NULL, "couponsGross" BIGINT NOT NULL, "grossMicroUsdt" BIGINT NOT NULL,
  "feeMicroUsdt" BIGINT NOT NULL, "netMicroUsdt" BIGINT NOT NULL,
  "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING_APPROVAL', "chainTxHash" TEXT,
  "broadcastedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Withdrawal_pkey" PRIMARY KEY ("id"), CONSTRAINT "Withdrawal_amounts_check" CHECK ("couponsGross" > 0 AND "grossMicroUsdt" > 0 AND "feeMicroUsdt" >= 0 AND "netMicroUsdt" > 0)
);
CREATE TABLE "ChainCursor" ("id" INTEGER NOT NULL DEFAULT 1, "nextBlock" BIGINT NOT NULL, "lastBlockHash" TEXT, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ChainCursor_pkey" PRIMARY KEY ("id"));
CREATE TABLE "AdminUser" ("id" UUID NOT NULL DEFAULT gen_random_uuid(), "username" TEXT NOT NULL, "passwordHash" TEXT NOT NULL, "role" "AdminRole" NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id"));
CREATE TABLE "AdminAuditLog" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "adminUserId" UUID NOT NULL, "action" TEXT NOT NULL,
  "entityType" TEXT NOT NULL, "entityId" TEXT NOT NULL, "oldValue" TEXT, "newValue" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_phoneNumber_key" ON "User"("phoneNumber");
CREATE UNIQUE INDEX "User_barcodeId_key" ON "User"("barcodeId");
CREATE UNIQUE INDEX "DepositAddress_derivationIndex_key" ON "DepositAddress"("derivationIndex");
CREATE UNIQUE INDEX "DepositAddress_address_key" ON "DepositAddress"("address");
CREATE UNIQUE INDEX "LedgerAccount_type_userId_asset_key" ON "LedgerAccount"("type", "userId", "asset");
CREATE UNIQUE INDEX "LedgerAccount_system_singleton_key" ON "LedgerAccount"("type", "asset") WHERE "userId" IS NULL;
CREATE INDEX "LedgerAccount_type_asset_idx" ON "LedgerAccount"("type", "asset");
CREATE UNIQUE INDEX "Transaction_externalRef_key" ON "Transaction"("externalRef");
CREATE INDEX "Transaction_userId_createdAt_idx" ON "Transaction"("userId", "createdAt");
CREATE INDEX "LedgerEntry_transactionId_idx" ON "LedgerEntry"("transactionId");
CREATE UNIQUE INDEX "EscrowHold_transactionId_key" ON "EscrowHold"("transactionId");
CREATE INDEX "EscrowHold_senderId_status_idx" ON "EscrowHold"("senderId", "status");
CREATE INDEX "EscrowHold_expiresAt_status_idx" ON "EscrowHold"("expiresAt", "status");
CREATE UNIQUE INDEX "Withdrawal_transactionId_key" ON "Withdrawal"("transactionId");
CREATE INDEX "Withdrawal_status_createdAt_idx" ON "Withdrawal"("status", "createdAt");
CREATE UNIQUE INDEX "AdminUser_username_key" ON "AdminUser"("username");
CREATE INDEX "AdminAuditLog_entityType_entityId_idx" ON "AdminAuditLog"("entityType", "entityId");

ALTER TABLE "DepositAddress" ADD CONSTRAINT "DepositAddress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_fromAccountId_fkey" FOREIGN KEY ("fromAccountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_toAccountId_fkey" FOREIGN KEY ("toAccountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EscrowHold" ADD CONSTRAINT "EscrowHold_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EscrowHold" ADD CONSTRAINT "EscrowHold_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EscrowHold" ADD CONSTRAINT "EscrowHold_escrowAccountId_fkey" FOREIGN KEY ("escrowAccountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EscrowHold" ADD CONSTRAINT "EscrowHold_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdminAuditLog" ADD CONSTRAINT "AdminAuditLog_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
