CREATE TABLE "BalanceDisclosureRequest" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "deniedAt" TIMESTAMP(3),

    CONSTRAINT "BalanceDisclosureRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BalanceDisclosureRequest_userId_createdAt_idx"
  ON "BalanceDisclosureRequest"("userId", "createdAt");

ALTER TABLE "BalanceDisclosureRequest"
  ADD CONSTRAINT "BalanceDisclosureRequest_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
