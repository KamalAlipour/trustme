-- AlterTable
ALTER TABLE "User" ADD COLUMN     "biometricEnrolledAt" TIMESTAMP(3),
ADD COLUMN     "pinResetQuarantineUntil" TIMESTAMP(3),
ADD COLUMN     "securitySetupCompletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "User_pinResetQuarantineUntil_idx" ON "User"("pinResetQuarantineUntil");
