-- AlterTable
ALTER TABLE "PayCode" ADD COLUMN     "amountMicroUsdt" BIGINT,
ADD COLUMN     "merchantId" UUID;

-- CreateIndex
CREATE INDEX "PayCode_merchantId_status_expiresAt_idx" ON "PayCode"("merchantId", "status", "expiresAt");

-- AddForeignKey
ALTER TABLE "PayCode" ADD CONSTRAINT "PayCode_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
