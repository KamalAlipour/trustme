ALTER TYPE "TransactionStatus" ADD VALUE 'CONFIRMED';
ALTER TYPE "TransactionStatus" ADD VALUE 'REJECTED';
ALTER TYPE "WithdrawalStatus" ADD VALUE 'REJECTED';
ALTER TABLE "User" ADD COLUMN "dustMicroUsdt" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD CONSTRAINT "User_dustMicroUsdt_check" CHECK ("dustMicroUsdt" >= 0 AND "dustMicroUsdt" < 10000);
