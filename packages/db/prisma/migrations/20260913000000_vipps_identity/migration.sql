CREATE TABLE "IdentityLoginAttempt" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'VIPPS_NO',
  "state" TEXT NOT NULL,
  "nonce" TEXT NOT NULL,
  "codeVerifier" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IdentityLoginAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IdentityLoginAttempt_state_key" ON "IdentityLoginAttempt"("state");
CREATE INDEX "IdentityLoginAttempt_userId_idx" ON "IdentityLoginAttempt"("userId");

ALTER TABLE "IdentityLoginAttempt"
  ADD CONSTRAINT "IdentityLoginAttempt_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
