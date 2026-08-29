CREATE TYPE "IdentityReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "IdentityReview" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "country" TEXT NOT NULL,
    "status" "IdentityReviewStatus" NOT NULL DEFAULT 'PENDING',
    "documentAssetId" UUID,
    "selfieAssetId" UUID,
    "decisionNote" TEXT,
    "decidedByAdminId" UUID,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdentityReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IdentityReview_documentAssetId_key" ON "IdentityReview"("documentAssetId");
CREATE UNIQUE INDEX "IdentityReview_selfieAssetId_key" ON "IdentityReview"("selfieAssetId");
CREATE INDEX "IdentityReview_status_createdAt_idx" ON "IdentityReview"("status", "createdAt");
CREATE INDEX "IdentityReview_userId_idx" ON "IdentityReview"("userId");

ALTER TABLE "IdentityReview" ADD CONSTRAINT "IdentityReview_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IdentityReview" ADD CONSTRAINT "IdentityReview_documentAssetId_fkey"
  FOREIGN KEY ("documentAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IdentityReview" ADD CONSTRAINT "IdentityReview_selfieAssetId_fkey"
  FOREIGN KEY ("selfieAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IdentityReview" ADD CONSTRAINT "IdentityReview_decidedByAdminId_fkey"
  FOREIGN KEY ("decidedByAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
