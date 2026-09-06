ALTER TABLE "AdminUser"
  ALTER COLUMN "passwordHash" DROP NOT NULL,
  ADD COLUMN "email" TEXT,
  ADD COLUMN "googleSubject" TEXT;

CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");
CREATE UNIQUE INDEX "AdminUser_googleSubject_key" ON "AdminUser"("googleSubject");

CREATE TABLE "AdminAllowedEmail" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "email" TEXT NOT NULL,
  "role" "AdminRole" NOT NULL,
  "createdById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminAllowedEmail_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminAllowedEmail_email_key" ON "AdminAllowedEmail"("email");

ALTER TABLE "AdminAllowedEmail"
  ADD CONSTRAINT "AdminAllowedEmail_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "AdminUser"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
