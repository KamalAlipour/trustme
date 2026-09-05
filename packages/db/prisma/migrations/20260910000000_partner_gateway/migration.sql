-- AlterEnum
ALTER TYPE "ApiKeyScope" ADD VALUE 'PARTNER_BUYERS';
ALTER TYPE "ApiKeyScope" ADD VALUE 'PARTNER_DEPOSITS';
ALTER TYPE "ApiKeyScope" ADD VALUE 'PARTNER_CHECKOUT';

-- CreateEnum
CREATE TYPE "PartnerDepositStatus" AS ENUM ('PENDING', 'CREDITED', 'REJECTED');

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN "secretCiphertext" TEXT,
ADD COLUMN "partnerUserId" UUID;

-- CreateTable
CREATE TABLE "PartnerBuyer" (
    "id" UUID NOT NULL,
    "partnerUserId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "externalRef" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PartnerBuyer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PartnerDepositNotice" (
    "id" UUID NOT NULL,
    "partnerUserId" UUID NOT NULL,
    "buyerUserId" UUID NOT NULL,
    "txHash" TEXT NOT NULL,
    "status" "PartnerDepositStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "amountMicroUsdt" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PartnerDepositNotice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PartnerCheckout" (
    "id" UUID NOT NULL,
    "partnerUserId" UUID NOT NULL,
    "buyerUserId" UUID NOT NULL,
    "sellerUserId" UUID NOT NULL,
    "escrowHoldId" UUID NOT NULL,
    "externalRef" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PartnerCheckout_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PartnerBuyer_userId_key" ON "PartnerBuyer"("userId");
CREATE UNIQUE INDEX "PartnerBuyer_partnerUserId_externalRef_key" ON "PartnerBuyer"("partnerUserId", "externalRef");
CREATE UNIQUE INDEX "PartnerDepositNotice_partnerUserId_txHash_key" ON "PartnerDepositNotice"("partnerUserId", "txHash");
CREATE UNIQUE INDEX "PartnerCheckout_escrowHoldId_key" ON "PartnerCheckout"("escrowHoldId");
CREATE UNIQUE INDEX "PartnerCheckout_partnerUserId_externalRef_key" ON "PartnerCheckout"("partnerUserId", "externalRef");
CREATE INDEX "ApiKey_partnerUserId_idx" ON "ApiKey"("partnerUserId");

ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_partnerUserId_fkey" FOREIGN KEY ("partnerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PartnerBuyer" ADD CONSTRAINT "PartnerBuyer_partnerUserId_fkey" FOREIGN KEY ("partnerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PartnerBuyer" ADD CONSTRAINT "PartnerBuyer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PartnerDepositNotice" ADD CONSTRAINT "PartnerDepositNotice_partnerUserId_fkey" FOREIGN KEY ("partnerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PartnerDepositNotice" ADD CONSTRAINT "PartnerDepositNotice_buyerUserId_fkey" FOREIGN KEY ("buyerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PartnerCheckout" ADD CONSTRAINT "PartnerCheckout_partnerUserId_fkey" FOREIGN KEY ("partnerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PartnerCheckout" ADD CONSTRAINT "PartnerCheckout_buyerUserId_fkey" FOREIGN KEY ("buyerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PartnerCheckout" ADD CONSTRAINT "PartnerCheckout_sellerUserId_fkey" FOREIGN KEY ("sellerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PartnerCheckout" ADD CONSTRAINT "PartnerCheckout_escrowHoldId_fkey" FOREIGN KEY ("escrowHoldId") REFERENCES "EscrowHold"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
