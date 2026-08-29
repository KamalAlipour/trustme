import { randomInt, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@trustme/db';
import { transferCoupons } from '@trustme/core';

type ChurnOptions = {
  enabled: boolean;
  transfersPerTick: number;
  maxCouponsPerTransfer: number;
};

type ChurnLog = {
  warn: (message: string) => void;
};

type DemoCouponAccount = {
  id: string;
  userId: string;
  balance: bigint;
};

async function randomSender(prisma: PrismaClient): Promise<DemoCouponAccount | null> {
  const rows = await prisma.$queryRaw<DemoCouponAccount[]>(Prisma.sql`
    SELECT account."id", account."userId", account."balance"
    FROM "LedgerAccount" account
    INNER JOIN "User" users ON users."id" = account."userId"
    WHERE account."type" = 'USER_COUPON'
      AND account."asset" = 'COUPON'
      AND users."isDemo" = true
      AND account."balance" > 0
    ORDER BY random()
    LIMIT 1
  `);
  return rows[0] ?? null;
}

async function randomRecipient(prisma: PrismaClient, senderId: string): Promise<DemoCouponAccount | null> {
  const rows = await prisma.$queryRaw<DemoCouponAccount[]>(Prisma.sql`
    SELECT account."id", account."userId", account."balance"
    FROM "LedgerAccount" account
    INNER JOIN "User" users ON users."id" = account."userId"
    WHERE account."type" = 'USER_COUPON'
      AND account."asset" = 'COUPON'
      AND users."isDemo" = true
      AND account."id" <> ${senderId}::uuid
    ORDER BY random()
    LIMIT 1
  `);
  return rows[0] ?? null;
}

export async function churnDemoCoupons(
  prisma: PrismaClient,
  options: ChurnOptions,
  log: ChurnLog,
): Promise<{ status: 'disabled' } | { status: 'ok'; transfers: number; skipped: number }> {
  if (!options.enabled) return { status: 'disabled' };

  let transfers = 0;
  let skipped = 0;
  for (let attempt = 0; attempt < options.transfersPerTick; attempt += 1) {
    try {
      const sender = await randomSender(prisma);
      if (sender === null) {
        skipped += 1;
        continue;
      }
      const recipient = await randomRecipient(prisma, sender.id);
      if (recipient === null) {
        skipped += 1;
        continue;
      }
      const users = await prisma.user.findMany({
        where: { id: { in: [sender.userId, recipient.userId] } },
        select: { id: true, isDemo: true },
      });
      const senderUser = users.find((user) => user.id === sender.userId);
      const recipientUser = users.find((user) => user.id === recipient.userId);
      if (senderUser?.isDemo !== true || recipientUser?.isDemo !== true) {
        throw new Error('demo churn requires two demo users');
      }
      const maxAmount = sender.balance < BigInt(options.maxCouponsPerTransfer)
        ? Number(sender.balance)
        : options.maxCouponsPerTransfer;
      if (maxAmount < 1) {
        skipped += 1;
        continue;
      }
      await transferCoupons(prisma, {
        userId: sender.userId,
        counterpartyUserId: recipient.userId,
        externalRef: `demo-churn:${randomUUID()}`,
        fromAccountId: sender.id,
        toAccountId: recipient.id,
        amountCoupons: BigInt(randomInt(1, maxAmount + 1)),
      });
      transfers += 1;
    } catch (error) {
      skipped += 1;
      log.warn(`demo churn transfer skipped: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  return { status: 'ok', transfers, skipped };
}
