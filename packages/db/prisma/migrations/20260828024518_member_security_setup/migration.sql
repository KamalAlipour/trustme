-- AlterTable
ALTER TABLE "User" ADD COLUMN     "biometricEnrolledAt" TIMESTAMP(3),
ADD COLUMN     "pinResetQuarantineUntil" TIMESTAMP(3),
ADD COLUMN     "securitySetupCompletedAt" TIMESTAMP(3),
ADD COLUMN     "setupAcknowledgedAt" TIMESTAMP(3);

-- Existing PIN-protected accounts completed the pre-feature security flow. They
-- are acknowledged rather than marked biometric-enrolled, because no biometric
-- enrolment was ever recorded for them.
UPDATE "User"
SET "setupAcknowledgedAt" = NOW(),
    "securitySetupCompletedAt" = NOW()
WHERE "pinHash" IS NOT NULL;

-- CreateIndex
CREATE INDEX "User_pinResetQuarantineUntil_idx" ON "User"("pinResetQuarantineUntil");
