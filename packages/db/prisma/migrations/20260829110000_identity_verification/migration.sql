CREATE TYPE "IdentityVerificationStatus" AS ENUM ('UNVERIFIED', 'VERIFIED', 'MISMATCH', 'INCONCLUSIVE');

ALTER TABLE "User"
  ADD COLUMN "identityVerificationStatus" "IdentityVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
  ADD COLUMN "identityVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "nationalIdHash" TEXT,
  ADD COLUMN "identityCheckCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastIdentityCheckAt" TIMESTAMP(3);

CREATE TABLE "IdentityCheck" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'SHAHKAR',
    "status" "IdentityVerificationStatus" NOT NULL,
    "providerCode" INTEGER,
    "nationalIdHash" TEXT NOT NULL,
    "mobileHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdentityCheck_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IdentityCheck_userId_idx" ON "IdentityCheck"("userId");

ALTER TABLE "IdentityCheck" ADD CONSTRAINT "IdentityCheck_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
