CREATE TYPE "ApiKeyScope" AS ENUM (
    'READ_MARKET_AVERAGE',
    'READ_RESERVES',
    'WRITE_EXECUTE_TRANSFER_ON_BEHALF_OF_USER'
);

CREATE TABLE "ApiKey" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" "ApiKeyScope"[],
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApiKey_keyPrefix_key" ON "ApiKey"("keyPrefix");
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");
CREATE INDEX "ApiKey_createdById_idx" ON "ApiKey"("createdById");

ALTER TABLE "ApiKey"
ADD CONSTRAINT "ApiKey_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "AdminUser"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
