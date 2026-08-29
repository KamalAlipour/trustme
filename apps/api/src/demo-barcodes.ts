import { AccountType, Asset, Prisma, prisma } from '@trustme/db';
import { issueDemoCoupons, readDemoCirculation, reconcileDemoIssuance } from '@trustme/core';
import { provisionUser } from './user-provisioning.js';

const RESERVED_PHONE_PREFIX = '+99000';
const DEFAULT_BATCH_SIZE = 500;

function requireMutationPermission(): void {
  if (process.env.ALLOW_DEMO_DATA !== 'true') {
    throw new Error('demo data mutations require ALLOW_DEMO_DATA=true');
  }
}

function positiveInteger(value: string | undefined, name: string): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is too large`);
  return parsed;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function phoneForIndex(index: number): string {
  return `${RESERVED_PHONE_PREFIX}${String(index).padStart(8, '0')}`;
}

async function generate(args: string[]): Promise<void> {
  requireMutationPermission();
  const count = positiveInteger(option(args, '--count'), '--count');
  const min = option(args, '--min-coupons') === undefined ? 1 : positiveInteger(option(args, '--min-coupons'), '--min-coupons');
  const max = option(args, '--max-coupons') === undefined ? 10 : positiveInteger(option(args, '--max-coupons'), '--max-coupons');
  const batch = option(args, '--batch') === undefined ? DEFAULT_BATCH_SIZE : positiveInteger(option(args, '--batch'), '--batch');
  if (min > max) throw new Error('--min-coupons cannot exceed --max-coupons');
  const depositXpub = process.env.DEPOSIT_XPUB;
  if (!depositXpub) throw new Error('DEPOSIT_XPUB is required');
  let created = 0;
  for (let start = 1; start <= count; start += batch) {
    const end = Math.min(count, start + batch - 1);
    for (let index = start; index <= end; index += 1) {
      const phoneNumber = phoneForIndex(index);
      const existing = await prisma.user.findUnique({ where: { phoneNumber } });
      if (existing !== null) {
        if (!existing.isDemo) throw new Error(`reserved demo phone belongs to a non-demo user: ${phoneNumber}`);
        continue;
      }
      const user = await provisionUser(prisma, { depositXpub }, {
        phoneNumber,
        displayName: `Demo ${String(index).padStart(6, '0')}`,
        isDemo: true,
      });
      const account = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: user.id, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
      const issuance = await prisma.ledgerAccount.findFirstOrThrow({ where: { type: AccountType.SYSTEM_DEMO_ISSUANCE, asset: Asset.COUPON, userId: null } });
      const amount = BigInt(min + Math.floor(Math.random() * (max - min + 1)));
      await issueDemoCoupons(prisma, {
        userId: user.id,
        userCouponAccountId: account.id,
        demoIssuanceAccountId: issuance.id,
        amountCoupons: amount,
        externalRef: `demo:${user.id}:issue`,
      });
      created += 1;
    }
  }
  console.log(`created ${created} demo users`);
}

async function assertPurgeSafe(tx: Prisma.TransactionClient, userId: string, accountIds: string[]): Promise<void> {
  const entries = await tx.ledgerEntry.findMany({
    where: { OR: [{ fromAccountId: { in: accountIds } }, { toAccountId: { in: accountIds } }] },
    include: { fromAccount: { include: { user: { select: { isDemo: true } } } }, toAccount: { include: { user: { select: { isDemo: true } } } } },
  });
  for (const entry of entries) {
    for (const account of [entry.fromAccount, entry.toAccount]) {
      if (account.userId !== null && account.userId !== userId && account.user?.isDemo !== true) {
        throw new Error(`refusing to purge demo user ${userId}: ledger entry touches a non-demo account`);
      }
      if (account.userId === null && account.type !== AccountType.SYSTEM_DEMO_ISSUANCE) {
        throw new Error(`refusing to purge demo user ${userId}: ledger entry touches a non-demo account`);
      }
    }
  }
}

async function purge(args: string[]): Promise<void> {
  requireMutationPermission();
  const all = args.includes('--all');
  const countValue = option(args, '--count');
  if (all === (countValue !== undefined)) throw new Error('purge requires exactly one of --count N or --all');
  const count = all ? undefined : positiveInteger(countValue, '--count');
  const users = await prisma.user.findMany({
    where: { isDemo: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    ...(count === undefined ? {} : { take: count }),
    select: { id: true },
  });
  let deleted = 0;
  for (const selected of users) {
    await prisma.$transaction(async (tx) => {
      const demoIssuance = await tx.ledgerAccount.findFirstOrThrow({
        where: { type: AccountType.SYSTEM_DEMO_ISSUANCE, asset: Asset.COUPON, userId: null },
        select: { id: true },
      });
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "LedgerAccount" WHERE "id" = ${demoIssuance.id}::uuid FOR UPDATE`);
      const couponAccount = await tx.ledgerAccount.findFirstOrThrow({
        where: { userId: selected.id, type: AccountType.USER_COUPON, asset: Asset.COUPON },
        select: { id: true, balance: true },
      });
      const purgedCouponBalance = couponAccount.balance;
      const accounts = await tx.ledgerAccount.findMany({ where: { userId: selected.id }, select: { id: true } });
      const accountIds = accounts.map((account) => account.id);
      await assertPurgeSafe(tx, selected.id, accountIds);
      const loans = await tx.loan.count({ where: { OR: [{ borrowerId: selected.id }, { lenderId: selected.id }] } });
      const guarantees = await tx.guarantee.count({ where: { guarantorId: selected.id } });
      if (loans > 0 || guarantees > 0) throw new Error(`refusing to purge demo user ${selected.id}: lending records exist`);
      const escrows = await tx.escrowHold.findMany({
        where: { OR: [{ senderId: selected.id }, { recipientId: selected.id }] },
        select: { sender: { select: { isDemo: true } }, recipient: { select: { isDemo: true } } },
      });
      if (escrows.some((escrow) => !escrow.sender.isDemo || !escrow.recipient.isDemo)) {
        throw new Error(`refusing to purge demo user ${selected.id}: escrow has a real participant`);
      }
      const contacts = await tx.contact.findMany({
        where: { OR: [{ ownerId: selected.id }, { contactUserId: selected.id }] },
        select: { owner: { select: { isDemo: true } }, contactUser: { select: { isDemo: true } } },
      });
      if (contacts.some((contact) => !contact.owner.isDemo || !contact.contactUser.isDemo)) {
        throw new Error(`refusing to purge demo user ${selected.id}: contact has a real participant`);
      }
      const [refunds, aidRequests, attachedMedia] = await Promise.all([
        tx.refundRequest.count({ where: { OR: [{ buyerId: selected.id }, { sellerId: selected.id }] } }),
        tx.aidRequest.count({ where: { applicantId: selected.id } }),
        tx.mediaAsset.count({ where: { ownerId: selected.id, OR: [{ refundRequestId: { not: null } }, { aidRequestId: { not: null } }] } }),
      ]);
      if (refunds > 0 || aidRequests > 0 || attachedMedia > 0) {
        throw new Error(`refusing to purge demo user ${selected.id}: financial review records exist`);
      }
      await tx.escrowHold.deleteMany({ where: { OR: [{ senderId: selected.id }, { recipientId: selected.id }] } });
      await tx.mediaAsset.deleteMany({ where: { ownerId: selected.id } });
      await tx.contact.deleteMany({ where: { OR: [{ ownerId: selected.id }, { contactUserId: selected.id }] } });
      await tx.emailVerification.deleteMany({ where: { userId: selected.id } });
      await tx.memberDevice.deleteMany({ where: { userId: selected.id } });
      await tx.depositSweep.deleteMany({ where: { depositAddress: { userId: selected.id } } });
      if (accountIds.length > 0) {
        await tx.ledgerEntry.deleteMany({ where: { OR: [{ fromAccountId: { in: accountIds } }, { toAccountId: { in: accountIds } }] } });
        await tx.transaction.deleteMany({ where: { userId: selected.id } });
        await tx.transaction.deleteMany({ where: { user: { isDemo: true }, entries: { none: {} } } });
        await tx.ledgerAccount.deleteMany({ where: { id: { in: accountIds } } });
      }
      await tx.depositAddress.deleteMany({ where: { userId: selected.id } });
      await tx.user.delete({ where: { id: selected.id } });
      await reconcileDemoIssuance(tx, purgedCouponBalance);
    });
    deleted += 1;
  }
  console.log(`deleted ${deleted} demo users`);
}

async function stats(): Promise<void> {
  const [userCount, couponsInCirculation] = await Promise.all([
    prisma.user.count({ where: { isDemo: true } }),
    readDemoCirculation(prisma),
  ]);
  console.log(`demo users: ${userCount}`);
  console.log(`demo coupons in circulation: ${couponsInCirculation}`);
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'generate') await generate(args);
  else if (command === 'purge') await purge(args);
  else if (command === 'stats') await stats();
  else throw new Error('usage: demo-barcodes.ts generate|purge|stats');
} finally {
  await prisma.$disconnect();
}
