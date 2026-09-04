-- CreateEnum
CREATE TYPE "CommissionDisputeStatus" AS ENUM ('OPEN', 'RESOLVED_BY_MARKETER', 'AUTO_RESOLVED');

-- AlterTable
ALTER TABLE "User"
  ADD COLUMN "commissionRateBps" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "marketerId" UUID;

-- CreateTable
CREATE TABLE "CommissionDispute" (
    "id" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "marketerId" UUID NOT NULL,
    "strikes" INTEGER NOT NULL DEFAULT 1,
    "lastStrikeAt" TIMESTAMP(3) NOT NULL,
    "openedRateBps" INTEGER NOT NULL,
    "status" "CommissionDisputeStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedRateBps" INTEGER,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionDispute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommissionDispute_sellerId_status_idx" ON "CommissionDispute"("sellerId", "status");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_marketerId_fkey"
  FOREIGN KEY ("marketerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CommissionDispute" ADD CONSTRAINT "CommissionDispute_sellerId_fkey"
  FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CommissionDispute" ADD CONSTRAINT "CommissionDispute_marketerId_fkey"
  FOREIGN KEY ("marketerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Coupon fee collection remains a customer liability and may hold positive coupons.
ALTER TABLE "LedgerAccount" DROP CONSTRAINT "LedgerAccount_asset_type_check";
ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_asset_type_check" CHECK (
  (("type" = 'USER_COUPON') AND ("asset" = 'COUPON') AND ("balance" >= 0))
  OR (("type" = 'CHARITY_COUPON') AND ("asset" = 'COUPON') AND ("balance" >= 0))
  OR (("type" = 'ESCROW') AND ("asset" = 'COUPON') AND ("balance" >= 0))
  OR (("type" = 'GUARANTEE_LOCK') AND ("asset" = 'COUPON') AND ("balance" >= 0))
  OR (("type" IN ('SYSTEM_COUPON_ISSUANCE', 'SYSTEM_DEMO_ISSUANCE')) AND ("asset" = 'COUPON') AND ("balance" <= 0))
  OR (("type" = 'SYSTEM_FEE_COLLECTION') AND ("asset" = 'COUPON') AND ("balance" >= 0))
  OR (("type" IN ('SYSTEM_VAULT_USDT', 'SYSTEM_WITHDRAWAL_PENDING', 'SYSTEM_FEE_COLLECTION')) AND ("asset" = 'USDT') AND ("balance" >= 0))
  OR (("type" = 'EXTERNAL_ONCHAIN') AND ("asset" = 'USDT'))
);
