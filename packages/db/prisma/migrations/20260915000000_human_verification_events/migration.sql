CREATE TABLE "HumanVerificationEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "route" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "userId" UUID,
    "remoteIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HumanVerificationEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HumanVerificationEvent_createdAt_idx" ON "HumanVerificationEvent"("createdAt");
