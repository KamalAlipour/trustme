CREATE TYPE "IdentityCaptureStep" AS ENUM ('DOCUMENT_FRONT', 'SELFIE_NEUTRAL', 'SELFIE_TURNED', 'SELFIE_WITH_DOCUMENT');

CREATE TABLE "IdentityCaptureSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "challengeCode" TEXT NOT NULL,
    "steps" "IdentityCaptureStep"[] NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdentityCaptureSession_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "IdentityReview"
  ADD COLUMN "captureSessionId" UUID,
  ADD COLUMN "challengeCode" TEXT,
  ADD COLUMN "documentFrontCapturedAt" TIMESTAMP(3),
  ADD COLUMN "selfieNeutralCapturedAt" TIMESTAMP(3),
  ADD COLUMN "selfieTurnedCapturedAt" TIMESTAMP(3),
  ADD COLUMN "selfieWithDocumentCapturedAt" TIMESTAMP(3);

ALTER TABLE "MediaAsset"
  ADD COLUMN "captureSessionId" UUID,
  ADD COLUMN "captureStep" "IdentityCaptureStep";

CREATE UNIQUE INDEX "IdentityReview_captureSessionId_key" ON "IdentityReview"("captureSessionId");
CREATE INDEX "IdentityCaptureSession_userId_createdAt_idx" ON "IdentityCaptureSession"("userId", "createdAt");
CREATE INDEX "IdentityCaptureSession_expiresAt_consumedAt_idx" ON "IdentityCaptureSession"("expiresAt", "consumedAt");
CREATE INDEX "MediaAsset_captureSessionId_captureStep_idx" ON "MediaAsset"("captureSessionId", "captureStep");
CREATE UNIQUE INDEX "MediaAsset_captureSessionId_captureStep_key" ON "MediaAsset"("captureSessionId", "captureStep");

ALTER TABLE "IdentityCaptureSession" ADD CONSTRAINT "IdentityCaptureSession_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IdentityReview" ADD CONSTRAINT "IdentityReview_captureSessionId_fkey"
  FOREIGN KEY ("captureSessionId") REFERENCES "IdentityCaptureSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_captureSessionId_fkey"
  FOREIGN KEY ("captureSessionId") REFERENCES "IdentityCaptureSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
