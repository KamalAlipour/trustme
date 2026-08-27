-- AlterTable
ALTER TABLE "EscrowHold" ADD COLUMN "releaseTransactionId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "EscrowHold_releaseTransactionId_key" ON "EscrowHold"("releaseTransactionId");

-- AddForeignKey
ALTER TABLE "EscrowHold" ADD CONSTRAINT "EscrowHold_releaseTransactionId_fkey" FOREIGN KEY ("releaseTransactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
