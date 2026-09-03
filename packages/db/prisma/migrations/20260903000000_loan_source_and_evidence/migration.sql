ALTER TABLE "Loan"
  ADD COLUMN "requestedLenderId" UUID,
  ADD COLUMN "description" TEXT;

ALTER TABLE "MediaAsset"
  ADD COLUMN "loanId" UUID;

CREATE INDEX "Loan_requestedLenderId_status_idx" ON "Loan"("requestedLenderId", "status");
CREATE INDEX "MediaAsset_loanId_idx" ON "MediaAsset"("loanId");

ALTER TABLE "Loan"
  ADD CONSTRAINT "Loan_requestedLenderId_fkey"
  FOREIGN KEY ("requestedLenderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MediaAsset"
  ADD CONSTRAINT "MediaAsset_loanId_fkey"
  FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
