import {
  AccountType,
  Asset,
  CommissionDisputeStatus,
  Prisma,
  PrismaClient,
} from '@trustme/db';
import { DomainError } from './domain-error.js';
import type { LedgerLeg } from './ledger.js';

const BPS_DENOMINATOR = 10_000n;
export const STRIKE_INTERVAL_MS = 10 * 24 * 60 * 60 * 1000;

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
): Promise<LedgerLeg[]> {
  const [buyer, seller, sellerAccount] = await Promise.all([
    tx.user.findUniqueOrThrow({ where: { id: input.buyerId }, select: { id: true, marketerId: true, isDemo: true } }),
    tx.user.findUniqueOrThrow({ where: { id: input.sellerId }, select: { id: true, marketerId: true, commissionRateBps: true, isDemo: true } }),
    tx.ledgerAccount.findUniqueOrThrow({ where: { id: input.sellerAccountId }, select: { id: true, type: true, asset: true, userId: true } }),
  ]);
  if (sellerAccount.type !== AccountType.USER_COUPON || sellerAccount.asset !== Asset.COUPON || sellerAccount.userId !== seller.id) return [];
  const split = splitCommission(input.amountCoupons, seller.commissionRateBps);
  if (seller.isDemo || seller.commissionRateBps === 0 || split.fee === 0n) return [];
  const treasury = await tx.ledgerAccount.findFirstOrThrow({ where: { userId: null, type: AccountType.SYSTEM_FEE_COLLECTION, asset: Asset.COUPON }, select: { id: true } });

  let treasuryAmount = split.treasury;
  const legs: LedgerLeg[] = [];
  const marketerIds = [buyer.marketerId, seller.marketerId];
  const shares = [split.buyerMarketer, split.sellerMarketer];
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
    legs.push({ fromAccountId: sellerAccount.id, toAccountId: account.id, amount: share, asset: Asset.COUPON });
  }
  if (treasuryAmount > 0n) legs.unshift({ fromAccountId: sellerAccount.id, toAccountId: treasury.id, amount: treasuryAmount, asset: Asset.COUPON });
  return legs;
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
    if (seller.commissionRateBps <= average) throw new DomainError('dispute rejected: rate is already at or below market average', 409);
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
