CREATE TYPE "BalanceDisclosureStatus" AS ENUM ('PENDING', 'CONSUMED', 'DENIED', 'EXPIRED');
ALTER TYPE "TransactionType" ADD VALUE 'PURCHASE';
ALTER TYPE "TransactionType" ADD VALUE 'DONATION';

CREATE TABLE "BalanceDisclosureRequest" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "status" "BalanceDisclosureStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "BalanceDisclosureRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BalanceDisclosureRequest_userId_status_idx" ON "BalanceDisclosureRequest"("userId", "status");
CREATE INDEX "BalanceDisclosureRequest_status_expiresAt_idx" ON "BalanceDisclosureRequest"("status", "expiresAt");

ALTER TABLE "BalanceDisclosureRequest"
  ADD CONSTRAINT "BalanceDisclosureRequest_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
