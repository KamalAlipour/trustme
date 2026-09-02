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
ALTER TABLE "PayCode" ADD COLUMN     "amountMicroUsdt" BIGINT,
ADD COLUMN     "merchantId" UUID;

-- CreateIndex
CREATE INDEX "PayCode_merchantId_status_expiresAt_idx" ON "PayCode"("merchantId", "status", "expiresAt");

-- AddForeignKey
ALTER TABLE "MemberWallet" ADD CONSTRAINT "MemberWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowBalance" ADD CONSTRAINT "EscrowBalance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayCode" ADD CONSTRAINT "PayCode_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayCode" ADD CONSTRAINT "PayCode_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowSettlement" ADD CONSTRAINT "EscrowSettlement_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowSettlement" ADD CONSTRAINT "EscrowSettlement_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowUnload" ADD CONSTRAINT "EscrowUnload_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
