ALTER TABLE "User" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "User_isDemo_idx" ON "User"("isDemo");

ALTER TABLE "LedgerAccount" DROP CONSTRAINT "LedgerAccount_asset_type_check";
ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_asset_type_check" CHECK (
  (("type" = 'USER_COUPON') AND ("asset" = 'COUPON') AND ("balance" >= 0))
  OR (("type" = 'CHARITY_COUPON') AND ("asset" = 'COUPON') AND ("balance" >= 0))
  OR (("type" = 'ESCROW') AND ("asset" = 'COUPON') AND ("balance" >= 0))
  OR (("type" = 'GUARANTEE_LOCK') AND ("asset" = 'COUPON') AND ("balance" >= 0))
  OR (("type" IN ('SYSTEM_COUPON_ISSUANCE', 'SYSTEM_DEMO_ISSUANCE')) AND ("asset" = 'COUPON') AND ("balance" <= 0))
  OR (("type" IN ('SYSTEM_VAULT_USDT', 'SYSTEM_WITHDRAWAL_PENDING', 'SYSTEM_FEE_COLLECTION')) AND ("asset" = 'USDT') AND ("balance" >= 0))
  OR (("type" = 'EXTERNAL_ONCHAIN') AND ("asset" = 'USDT'))
);
