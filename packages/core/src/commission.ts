import {
  AccountType,
  Asset,
  CommissionPayoutRole,
  CommissionDisputeStatus,
  Prisma,
  PrismaClient,
} from '@trustme/db';
import { DomainError } from './domain-error.js';
import type { LedgerLeg } from './ledger.js';

const BPS_DENOMINATOR = 10_000n;
export const STRIKE_INTERVAL_MS = 10 * 24 * 60 * 60 * 1000;

export type PendingPayout = {
  recipientId: string;
  sourceUserId: string;
  role: CommissionPayoutRole;
  amount: bigint;
};

export function splitTrainerCut(share: bigint, cutBps: number): { marketer: bigint; trainer: bigint } {
  if (share < 0n || !Number.isInteger(cutBps) || cutBps < 0 || cutBps > 10_000) {
    throw new DomainError('trainer cut inputs are invalid');
  }
  const trainer = share * BigInt(cutBps) / BPS_DENOMINATOR;
  return { marketer: share - trainer, trainer };
}

export function splitCommission(amountCoupons: bigint, rateBps: number) {
  if (amountCoupons < 0n || rateBps < 0) throw new DomainError('commission inputs must be non-negative');
  const fee = amountCoupons * BigInt(rateBps) / BPS_DENOMINATOR;
  const third = fee / 3n;
  return {
    fee,
    treasury: fee - (third * 2n),
    buyerMarketer: third,
    sellerMarketer: third,
  };
}

async function userCouponAccount(tx: Prisma.TransactionClient, userId: string) {
  return tx.ledgerAccount.findFirst({
    where: { userId, type: AccountType.USER_COUPON, asset: Asset.COUPON },
    select: { id: true },
  });
}

export async function commissionLegs(
  tx: Prisma.TransactionClient,
  input: { buyerId: string; sellerId: string; sellerAccountId: string; amountCoupons: bigint },
): Promise<{ legs: LedgerLeg[]; payouts: PendingPayout[] }> {
  const [buyer, seller, sellerAccount] = await Promise.all([
    tx.user.findUniqueOrThrow({ where: { id: input.buyerId }, select: { id: true, marketerId: true, isDemo: true } }),
    tx.user.findUniqueOrThrow({ where: { id: input.sellerId }, select: { id: true, marketerId: true, commissionRateBps: true, isDemo: true } }),
    tx.ledgerAccount.findUniqueOrThrow({ where: { id: input.sellerAccountId }, select: { id: true, type: true, asset: true, userId: true } }),
  ]);
  if (sellerAccount.type !== AccountType.USER_COUPON || sellerAccount.asset !== Asset.COUPON || sellerAccount.userId !== seller.id) return { legs: [], payouts: [] };
  const split = splitCommission(input.amountCoupons, seller.commissionRateBps);
  if (seller.isDemo || seller.commissionRateBps === 0 || split.fee === 0n) return { legs: [], payouts: [] };
  const treasury = await tx.ledgerAccount.findFirstOrThrow({ where: { userId: null, type: AccountType.SYSTEM_FEE_COLLECTION, asset: Asset.COUPON }, select: { id: true } });
  const setting = await tx.systemSetting.findUnique({ where: { key: 'TRAINER_CUT_BPS' }, select: { value: true } });
  const cutBps = trainerCutBps(new Map(setting === null ? [] : [['TRAINER_CUT_BPS', setting.value]]));

  let treasuryAmount = split.treasury;
  const legs: LedgerLeg[] = [];
  const payouts: PendingPayout[] = [];
  const marketerIds = [buyer.marketerId, seller.marketerId];
  const shares = [split.buyerMarketer, split.sellerMarketer];
  const roles = [CommissionPayoutRole.BUYER_MARKETER, CommissionPayoutRole.SELLER_MARKETER];
  for (let index = 0; index < marketerIds.length; index += 1) {
    const marketerId = marketerIds[index];
    const share = shares[index]!;
    if (share === 0n) {
      treasuryAmount += share;
      continue;
    }
    if (marketerId === undefined || marketerId === null || marketerId === buyer.id || marketerId === seller.id) {
      treasuryAmount += share;
      continue;
    }
    const marketer = await tx.user.findUnique({ where: { id: marketerId }, select: { id: true, isDemo: true } });
    if (marketer === null || marketer.isDemo !== buyer.isDemo) {
      treasuryAmount += share;
      continue;
    }
    const account = await userCouponAccount(tx, marketer.id);
    if (account === null || account.id === input.sellerAccountId || account.id === treasury.id) {
      treasuryAmount += share;
      continue;
    }
    const marketerPart = splitTrainerCut(share, cutBps);
    const marketerWithTrainer = await tx.user.findUnique({
      where: { id: marketer.id },
      select: { trainerId: true },
    });
    const trainer = marketerWithTrainer?.trainerId === undefined || marketerWithTrainer.trainerId === null
      ? null
      : await tx.user.findUnique({
        where: { id: marketerWithTrainer.trainerId },
        select: { id: true, isDemo: true },
      });
    const trainerAccount = trainer === null || trainer === undefined
      || trainer.id === buyer.id
      || trainer.id === seller.id
      || trainer.id === marketer.id
      || trainer.isDemo !== buyer.isDemo
      ? null
      : await userCouponAccount(tx, trainer.id);
    if (trainer === null || trainerAccount === null || trainerAccount.id === input.sellerAccountId || trainerAccount.id === treasury.id || marketerPart.trainer === 0n) {
      if (share > 0n) {
        legs.push({ fromAccountId: sellerAccount.id, toAccountId: account.id, amount: share, asset: Asset.COUPON });
        payouts.push({ recipientId: marketer.id, sourceUserId: index === 0 ? buyer.id : seller.id, role: roles[index]!, amount: share });
      }
      continue;
    }
    if (marketerPart.marketer > 0n) {
      legs.push({ fromAccountId: sellerAccount.id, toAccountId: account.id, amount: marketerPart.marketer, asset: Asset.COUPON });
      payouts.push({ recipientId: marketer.id, sourceUserId: index === 0 ? buyer.id : seller.id, role: roles[index]!, amount: marketerPart.marketer });
    }
    if (marketerPart.trainer > 0n) {
      legs.push({ fromAccountId: sellerAccount.id, toAccountId: trainerAccount.id, amount: marketerPart.trainer, asset: Asset.COUPON });
      payouts.push({ recipientId: trainer.id, sourceUserId: marketer.id, role: CommissionPayoutRole.TRAINER, amount: marketerPart.trainer });
    }
  }
  if (treasuryAmount > 0n) legs.unshift({ fromAccountId: sellerAccount.id, toAccountId: treasury.id, amount: treasuryAmount, asset: Asset.COUPON });
  return { legs, payouts };
}

export async function recordCommissionPayouts(
  tx: Prisma.TransactionClient,
  transactionId: string,
  payouts: readonly PendingPayout[],
) {
  if (payouts.length === 0) return;
  await tx.commissionPayout.createMany({
    data: payouts.map((payout) => ({ transactionId, ...payout })),
  });
}

export async function reverseCommissionPayouts(
  tx: Prisma.TransactionClient,
  originalTransactionId: string,
  reversalTransactionId: string,
) {
  const payouts = await tx.commissionPayout.findMany({ where: { transactionId: originalTransactionId } });
  if (payouts.length === 0) return;
  await tx.commissionPayout.createMany({
    data: payouts.map(({ recipientId, sourceUserId, role, amount }) => ({
      transactionId: reversalTransactionId,
      recipientId,
      sourceUserId,
      role,
      amount: -amount,
    })),
  });
}

export function trainerCutBps(settings: ReadonlyMap<string, string> | Record<string, string>): number {
  const value = settings instanceof Map ? settings.get('TRAINER_CUT_BPS') : (settings as Record<string, string>).TRAINER_CUT_BPS;
  const parsed = Number.parseInt(value ?? '2000', 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 10_000 ? parsed : 2000;
}

export async function networkAverageRateBps(tx: Prisma.TransactionClient): Promise<number> {
  const users = await tx.user.findMany({
    where: { isDemo: false, commissionRateBps: { gt: 0 } },
    select: { commissionRateBps: true },
  });
  if (users.length === 0) return 0;
  return Math.round(users.reduce((sum, user) => sum + user.commissionRateBps, 0) / users.length);
}

export async function setCommissionRate(
  prisma: PrismaClient,
  input: { userId: string; rateBps: number; floorBps: number },
) {
  if (!Number.isInteger(input.rateBps) || input.rateBps < 0) throw new DomainError('commission rate must be a non-negative integer');
  if (input.rateBps !== 0 && input.rateBps < input.floorBps) throw new DomainError('commission rate is below the floor');
  return prisma.user.update({ where: { id: input.userId }, data: { commissionRateBps: input.rateBps } });
}

export async function setMarketer(
  prisma: PrismaClient,
  input: { userId: string; marketerBarcodeId: string },
) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUniqueOrThrow({ where: { id: input.userId }, select: { id: true, marketerId: true, isDemo: true } });
    if (user.marketerId !== null) throw new DomainError('marketer is already set');
    const marketer = await tx.user.findUnique({ where: { barcodeId: input.marketerBarcodeId }, select: { id: true, isDemo: true } });
    if (marketer === null) throw new DomainError('marketer not found', 404);
    if (marketer.id === user.id) throw new DomainError('self-referral is not allowed');
    if (marketer.isDemo !== user.isDemo) throw new DomainError('marketer must be on the same demo side');
    return tx.user.update({ where: { id: user.id }, data: { marketerId: marketer.id } });
  });
}

export async function setTrainer(
  prisma: PrismaClient,
  input: { userId: string; trainerBarcodeId: string },
) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUniqueOrThrow({ where: { id: input.userId }, select: { id: true, trainerId: true, isDemo: true } });
    if (user.trainerId !== null) throw new DomainError('trainer is already set');
    const trainer = await tx.user.findUnique({ where: { barcodeId: input.trainerBarcodeId }, select: { id: true, isDemo: true, trainerId: true } });
    if (trainer === null) throw new DomainError('trainer not found', 404);
    if (trainer.id === user.id) throw new DomainError('self-referral is not allowed');
    if (trainer.isDemo !== user.isDemo) throw new DomainError('trainer must be on the same demo side');
    if (trainer.trainerId === user.id) throw new DomainError('trainer referral cycle is not allowed');
    return tx.user.update({ where: { id: user.id }, data: { trainerId: trainer.id } });
  });
}

export async function referralSummary(prisma: PrismaClient, userId: string) {
  const [marketers, sellers, customers] = await Promise.all([
    prisma.user.count({ where: { trainerId: userId } }),
    prisma.user.count({ where: { marketerId: userId, commissionRateBps: { gt: 0 } } }),
    prisma.user.count({ where: { marketerId: userId, commissionRateBps: 0 } }),
  ]);
  const [trainerEarned, sellerEarned, customerEarned] = await Promise.all([
    prisma.commissionPayout.aggregate({ where: { recipientId: userId, role: CommissionPayoutRole.TRAINER }, _sum: { amount: true } }),
    prisma.commissionPayout.aggregate({ where: { recipientId: userId, role: CommissionPayoutRole.SELLER_MARKETER }, _sum: { amount: true } }),
    prisma.commissionPayout.aggregate({ where: { recipientId: userId, role: CommissionPayoutRole.BUYER_MARKETER }, _sum: { amount: true } }),
  ]);
  return {
    marketers: { count: marketers, earnedCoupons: (trainerEarned._sum.amount ?? 0n).toString() },
    sellers: { count: sellers, earnedCoupons: (sellerEarned._sum.amount ?? 0n).toString() },
    customers: { count: customers, earnedCoupons: (customerEarned._sum.amount ?? 0n).toString() },
  };
}

export async function grantRateDiscount(
  prisma: PrismaClient,
  input: { marketerId: string; sellerId: string; newRateBps: number; floorBps: number },
) {
  return prisma.$transaction(async (tx) => {
    const seller = await tx.user.findUniqueOrThrow({ where: { id: input.sellerId }, select: { id: true, marketerId: true, commissionRateBps: true } });
    if (seller.marketerId !== input.marketerId) throw new DomainError('marketer is not assigned to this seller');
    if (input.newRateBps >= seller.commissionRateBps) throw new DomainError('discount rate must be lower than the current rate');
    if (input.newRateBps < input.floorBps) throw new DomainError('commission rate is below the floor');
    const updated = await tx.user.update({ where: { id: seller.id }, data: { commissionRateBps: input.newRateBps } });
    await tx.commissionDispute.updateMany({
      where: { sellerId: seller.id, status: CommissionDisputeStatus.OPEN },
      data: { status: CommissionDisputeStatus.RESOLVED_BY_MARKETER, resolvedRateBps: input.newRateBps, resolvedAt: new Date() },
    });
    return updated;
  });
}

export async function logCommissionStrike(prisma: PrismaClient, input: { sellerId: string; now?: Date }) {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const seller = await tx.user.findUniqueOrThrow({ where: { id: input.sellerId }, select: { id: true, marketerId: true, commissionRateBps: true } });
    if (seller.marketerId === null) throw new DomainError('seller has no marketer');
    const average = await networkAverageRateBps(tx);
    if (seller.commissionRateBps <= average) throw new DomainError('commission dispute is not available for this rate', 409);
    const dispute = await tx.commissionDispute.findFirst({ where: { sellerId: seller.id, status: CommissionDisputeStatus.OPEN } });
    if (dispute === null) {
      return tx.commissionDispute.create({
        data: { sellerId: seller.id, marketerId: seller.marketerId, strikes: 1, lastStrikeAt: now, openedRateBps: seller.commissionRateBps },
      });
    }
    if (dispute.strikes >= 3) throw new DomainError('maximum commission strikes reached');
    if (now.getTime() < dispute.lastStrikeAt.getTime() + STRIKE_INTERVAL_MS) throw new DomainError('commission strike is not yet allowed');
    return tx.commissionDispute.update({ where: { id: dispute.id }, data: { strikes: { increment: 1 }, lastStrikeAt: now } });
  });
}

export async function forceAutoResolve(prisma: PrismaClient, input: { sellerId: string; floorBps: number; now?: Date }) {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const dispute = await tx.commissionDispute.findFirst({ where: { sellerId: input.sellerId, status: CommissionDisputeStatus.OPEN } });
    if (dispute === null || dispute.strikes !== 3) throw new DomainError('commission dispute is not eligible for auto-resolution');
    if (now.getTime() < dispute.lastStrikeAt.getTime() + STRIKE_INTERVAL_MS) throw new DomainError('commission dispute is not yet eligible for auto-resolution');
    const rateBps = Math.max(await networkAverageRateBps(tx), input.floorBps);
    await tx.user.update({ where: { id: input.sellerId }, data: { commissionRateBps: rateBps } });
    return tx.commissionDispute.update({
      where: { id: dispute.id },
      data: { status: CommissionDisputeStatus.AUTO_RESOLVED, resolvedRateBps: rateBps, resolvedAt: now },
    });
  });
}

export function commissionFloorBps(settings: ReadonlyMap<string, string> | Record<string, string>, country: string | null | undefined): number {
  const read = (key: string): string | undefined => settings instanceof Map ? settings.get(key) : (settings as Record<string, string>)[key];
  const global = Number.parseInt(read('COMMISSION_FLOOR_BPS') ?? '300', 10);
  const countryValue = country === undefined || country === null ? undefined : (read('COMMISSION_FLOOR_BPS_BY_COUNTRY') ?? '')
    .split(',')
    .map((entry: string) => entry.trim().split('='))
    .find((parts: string[]) => parts[0]?.toUpperCase() === country.toUpperCase())?.[1];
  return countryValue === undefined ? global : Number.parseInt(countryValue, 10);
}
