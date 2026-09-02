ALTER TABLE "EscrowSettlement" ADD COLUMN "externalRef" TEXT;
CREATE UNIQUE INDEX "EscrowSettlement_externalRef_key" ON "EscrowSettlement"("externalRef");
