ALTER TABLE "User"
  ADD COLUMN "ibanNumber" TEXT,
  ADD COLUMN "ibanVerifiedAt" TIMESTAMP(3);

CREATE TABLE "BankAccountCheck" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'IBAN_MATCH',
    "status" "IdentityVerificationStatus" NOT NULL,
    "providerCode" INTEGER,
    "ibanHash" TEXT NOT NULL,
    "nationalIdHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankAccountCheck_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BankAccountCheck_userId_createdAt_idx" ON "BankAccountCheck"("userId", "createdAt");

ALTER TABLE "BankAccountCheck" ADD CONSTRAINT "BankAccountCheck_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
