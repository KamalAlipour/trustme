ALTER TABLE "MemberDevice"
ADD COLUMN "installationId" TEXT;

CREATE INDEX "MemberDevice_userId_installationId_idx"
ON "MemberDevice"("userId", "installationId");
