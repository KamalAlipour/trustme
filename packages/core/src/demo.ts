import { AccountType, Asset, Prisma, PrismaClient, TransactionStatus, TransactionType } from '@trustme/db';
import { DomainError } from './domain-error.js';
import { postWithClient } from './ledger.js';
import { withSerializableRetry } from './retry.js';

export async function issueDemoCoupons(
  prisma: PrismaClient,
  input: {
    userId: string;
    userCouponAccountId: string;
    demoIssuanceAccountId: string;
    amountCoupons: bigint;
    externalRef: string;
  },
) {
  if (input.amountCoupons <= 0n) throw new DomainError('demo issuance amount must be positive');
  return withSerializableRetry(prisma, async (tx) => {
    const existing = await tx.transaction.findUnique({ where: { externalRef: input.externalRef } });
    if (existing) return existing;
    const user = await tx.user.findUniqueOrThrow({ where: { id: input.userId }, select: { isDemo: true } });
    if (!user.isDemo) throw new DomainError('demo coupons require a demo account');
    const issuance = await tx.ledgerAccount.findUniqueOrThrow({ where: { id: input.demoIssuanceAccountId } });
    if (issuance.type !== AccountType.SYSTEM_DEMO_ISSUANCE || issuance.asset !== Asset.COUPON || issuance.userId !== null) {
      throw new DomainError('invalid demo issuance account');
    }
    const account = await tx.ledgerAccount.findUniqueOrThrow({ where: { id: input.userCouponAccountId } });
    if (account.type !== AccountType.USER_COUPON || account.asset !== Asset.COUPON || account.userId !== input.userId) {
      throw new DomainError('invalid demo coupon account');
    }
    return postWithClient(tx, {
      type: TransactionType.DEMO_ISSUE,
      externalRef: input.externalRef,
      userId: input.userId,
      status: TransactionStatus.CONFIRMED,
      amountCoupons: input.amountCoupons,
      legs: [{ fromAccountId: issuance.id, toAccountId: account.id, amount: input.amountCoupons, asset: Asset.COUPON }],
    });
  });
}

export async function readDemoCirculation(prisma: PrismaClient): Promise<bigint> {
  const account = await prisma.ledgerAccount.findFirst({
    where: { type: AccountType.SYSTEM_DEMO_ISSUANCE, asset: Asset.COUPON, userId: null },
    select: { balance: true },
  });
  return account === null ? 0n : -account.balance;
}

export async function assertSameDemoSide(tx: Prisma.TransactionClient, userIdA: string, userIdB: string): Promise<void> {
  const users = await tx.user.findMany({ where: { id: { in: [userIdA, userIdB] } }, select: { id: true, isDemo: true } });
  const a = users.find((user) => user.id === userIdA);
  const b = users.find((user) => user.id === userIdB);
  if (!a || !b) throw new DomainError('user not found', 404);
  if (a.isDemo !== b.isDemo) throw new DomainError('demo and real accounts cannot exchange coupons');
}

export async function assertNotDemoAccount(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { isDemo: true } });
  if (user.isDemo) throw new DomainError('demo accounts cannot withdraw');
}
