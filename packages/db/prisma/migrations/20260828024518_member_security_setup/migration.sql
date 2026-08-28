-- AlterTable
ALTER TABLE "User" ADD COLUMN     "biometricEnrolledAt" TIMESTAMP(3),
ADD COLUMN     "pinResetQuarantineUntil" TIMESTAMP(3),
ADD COLUMN     "securitySetupCompletedAt" TIMESTAMP(3),
ADD COLUMN     "setupAcknowledgedAt" TIMESTAMP(3);

-- Existing PIN-protected accounts completed the pre-feature security flow.
UPDATE "User"
SET "biometricEnrolledAt" = NOW(),
    "securitySetupCompletedAt" = NOW()
WHERE "pinHash" IS NOT NULL;

-- CreateIndex
CREATE INDEX "User_pinResetQuarantineUntil_idx" ON "User"("pinResetQuarantineUntil");
