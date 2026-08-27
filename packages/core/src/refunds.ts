import { Prisma, PrismaClient, AccountType, Asset, RefundStatus, TransactionStatus, TransactionType } from '@trustme/db';
import { DomainError } from './domain-error.js';
import { postWithClient } from './ledger.js';
import { withSerializableRetry } from './retry.js';

type RefundInput = {
  transactionId: string;
  buyerId: string;
  amountCoupons: bigint;
  reason: string;
  mediaIds?: readonly string[];
};

async function userCouponAccount(tx: Prisma.TransactionClient, userId: string) {
  return tx.ledgerAccount.findFirstOrThrow({ where: { userId, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
}

export async function createRefundRequest(prisma: PrismaClient, input: RefundInput) {
  if (input.amountCoupons <= 0n) throw new DomainError('refund amount must be positive');
  if (input.reason.trim().length === 0) throw new DomainError('refund reason is required');
  const mediaIds = [...new Set(input.mediaIds ?? [])];
  if (mediaIds.length > 10) throw new DomainError('no more than 10 media assets may be attached');
  return withSerializableRetry(prisma, async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Transaction" WHERE "id" = ${input.transactionId}::uuid FOR UPDATE`);
    const original = await tx.transaction.findUnique({
      where: { id: input.transactionId },
      include: { entries: { include: { fromAccount: true, toAccount: true } } },
    });
    if (
      original === null ||
      original.status !== TransactionStatus.CONFIRMED ||
      (original.type !== TransactionType.TRANSFER && original.type !== TransactionType.ESCROW_RELEASE)
    ) {
      throw new DomainError('transaction is not refundable');
    }
    const couponEntries = original.entries.filter((entry) => entry.asset === Asset.COUPON);
    if (
      couponEntries.length !== 1 ||
      couponEntries[0]!.fromAccount.type !== AccountType.USER_COUPON ||
      couponEntries[0]!.toAccount.type !== AccountType.USER_COUPON ||
      couponEntries[0]!.fromAccount.userId === null ||
      couponEntries[0]!.toAccount.userId === null ||
      couponEntries[0]!.fromAccount.userId !== input.buyerId
    ) {
      throw new DomainError('transaction is not refundable');
    }
    const buyerId = couponEntries[0]!.fromAccount.userId;
    const sellerId = couponEntries[0]!.toAccount.userId;
    const approved = await tx.refundRequest.aggregate({
      where: { transactionId: original.id, status: RefundStatus.APPROVED },
      _sum: { amountCoupons: true },
    });
    const refunded = approved._sum.amountCoupons ?? 0n;
    const refundable = couponEntries[0]!.amount - refunded;
    if (input.amountCoupons > refundable) throw new DomainError('refund exceeds refundable amount');
    const pending = await tx.refundRequest.findFirst({ where: { transactionId: original.id, status: RefundStatus.PENDING } });
    if (pending !== null) throw new DomainError('refund is already pending', 409);
    const media = await tx.mediaAsset.findMany({
      where: { id: { in: mediaIds }, ownerId: input.buyerId, refundRequestId: null, aidRequestId: null },
      select: { id: true },
    });
    if (media.length !== mediaIds.length) throw new DomainError('invalid media asset');
    const request = await tx.refundRequest.create({
      data: {
        transactionId: original.id,
        buyerId,
        sellerId,
        amountCoupons: input.amountCoupons,
        reason: input.reason.trim(),
      },
    });
    if (mediaIds.length > 0) {
      const attached = await tx.mediaAsset.updateMany({
        where: { id: { in: mediaIds }, ownerId: input.buyerId, refundRequestId: null, aidRequestId: null },
        data: { refundRequestId: request.id },
      });
      if (attached.count !== mediaIds.length) throw new DomainError('invalid media asset');
    }
    return request;
  });
}

export async function approveRefund(prisma: PrismaClient, input: { refundRequestId: string; sellerId: string }) {
  return withSerializableRetry(prisma, async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "RefundRequest" WHERE "id" = ${input.refundRequestId}::uuid FOR UPDATE`);
    const request = await tx.refundRequest.findUniqueOrThrow({ where: { id: input.refundRequestId } });
    if (request.sellerId !== input.sellerId) throw new DomainError('forbidden', 403);
    if (request.status === RefundStatus.APPROVED) return request;
    if (request.status !== RefundStatus.PENDING) throw new DomainError('refund is not pending', 409);
    const seller = await userCouponAccount(tx, request.sellerId);
    const buyer = await userCouponAccount(tx, request.buyerId);
    let transaction;
    try {
      transaction = await postWithClient(tx, {
        type: TransactionType.REFUND,
        externalRef: `refund:${request.id}`,
        userId: request.sellerId,
        status: TransactionStatus.CONFIRMED,
        amountCoupons: request.amountCoupons,
        legs: [{ fromAccountId: seller.id, toAccountId: buyer.id, amount: request.amountCoupons, asset: Asset.COUPON }],
      });
    } catch (error) {
      if (error instanceof DomainError && error.message.includes('cannot be negative')) {
        throw new DomainError('insufficient balance for refund', 409);
      }
      throw error;
    }
    return tx.refundRequest.update({
      where: { id: request.id },
      data: { status: RefundStatus.APPROVED, decidedAt: new Date(), refundTransactionId: transaction.id },
    });
  });
}

export async function rejectRefund(prisma: PrismaClient, input: { refundRequestId: string; sellerId: string; note: string }) {
  const note = input.note.trim();
  if (note.length === 0) throw new DomainError('rejection note is required');
  return withSerializableRetry(prisma, async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "RefundRequest" WHERE "id" = ${input.refundRequestId}::uuid FOR UPDATE`);
    const request = await tx.refundRequest.findUniqueOrThrow({ where: { id: input.refundRequestId } });
    if (request.sellerId !== input.sellerId) throw new DomainError('forbidden', 403);
    if (request.status !== RefundStatus.PENDING) throw new DomainError('refund is not pending', 409);
    return tx.refundRequest.update({
      where: { id: request.id },
      data: { status: RefundStatus.REJECTED, decisionNote: note, decidedAt: new Date() },
    });
  });
}
