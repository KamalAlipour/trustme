-- Make phone-based authentication optional for social accounts.
ALTER TABLE "User" ALTER COLUMN "phoneNumber" DROP NOT NULL;

CREATE TYPE "IdentityProvider" AS ENUM ('GOOGLE', 'APPLE');

CREATE TABLE "UserIdentity" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "IdentityProvider" NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserIdentity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserIdentity_provider_subject_key" ON "UserIdentity"("provider", "subject");
CREATE INDEX "UserIdentity_userId_idx" ON "UserIdentity"("userId");

ALTER TABLE "UserIdentity" ADD CONSTRAINT "UserIdentity_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
