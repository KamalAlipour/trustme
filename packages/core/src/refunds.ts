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

async function userCouponAccountId(tx: Prisma.TransactionClient, userId: string) {
  return tx.ledgerAccount.findFirstOrThrow({
    where: { userId, type: AccountType.USER_COUPON, asset: Asset.COUPON },
    select: { id: true },
  });
}

async function lockedUserCouponAccounts(tx: Prisma.TransactionClient, sellerId: string, buyerId: string) {
  const sellerIdRow = await userCouponAccountId(tx, sellerId);
  const buyerIdRow = await userCouponAccountId(tx, buyerId);
  const ids = [...new Set([sellerIdRow.id, buyerIdRow.id])];
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "LedgerAccount" WHERE "id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY "id" FOR UPDATE`);
  const accounts = await tx.ledgerAccount.findMany({ where: { id: { in: ids } } });
  const byId = new Map(accounts.map((account) => [account.id, account]));
  return {
    seller: byId.get(sellerIdRow.id)!,
    buyer: byId.get(buyerIdRow.id)!,
  };
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
      include: { entries: { include: { fromAccount: true, toAccount: true } }, escrowHold: true },
    });
    if (
      original === null ||
      original.status !== TransactionStatus.CONFIRMED ||
      (original.type !== TransactionType.TRANSFER && original.type !== TransactionType.ESCROW_RELEASE)
    ) {
      throw new DomainError('transaction is not refundable');
    }
    const couponEntries = original.entries.filter((entry) => entry.asset === Asset.COUPON);
    const entry = couponEntries.length === 1 ? couponEntries[0]! : null;
    let buyerId: string | null = null;
    let sellerId: string | null = null;
    if (
      entry !== null &&
      original.type === TransactionType.TRANSFER &&
      entry.fromAccount.type === AccountType.USER_COUPON &&
      entry.toAccount.type === AccountType.USER_COUPON &&
      entry.fromAccount.userId !== null &&
      entry.toAccount.userId !== null
    ) {
      buyerId = entry.fromAccount.userId;
      sellerId = entry.toAccount.userId;
    } else if (
      entry !== null &&
      original.type === TransactionType.ESCROW_RELEASE &&
      entry.fromAccount.type === AccountType.ESCROW &&
      entry.toAccount.type === AccountType.USER_COUPON &&
      entry.toAccount.userId !== null
    ) {
      const hold = original.escrowHold;
      if (hold !== null && hold.recipientId === entry.toAccount.userId) {
        buyerId = hold.senderId;
        sellerId = hold.recipientId;
      }
    }
    if (buyerId === null || sellerId === null || buyerId !== input.buyerId) {
      throw new DomainError('transaction is not refundable');
    }
    const approved = await tx.refundRequest.aggregate({
      where: { transactionId: original.id, status: RefundStatus.APPROVED },
      _sum: { amountCoupons: true },
    });
    const refunded = approved._sum.amountCoupons ?? 0n;
    const refundable = entry!.amount - refunded;
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
    if (request.sellerId !== input.sellerId) throw new DomainError('resource not found', 404);
    if (request.status === RefundStatus.APPROVED) return request;
    if (request.status !== RefundStatus.PENDING) throw new DomainError('refund is not pending', 409);
    const { seller, buyer } = await lockedUserCouponAccounts(tx, request.sellerId, request.buyerId);
    if (seller.balance < request.amountCoupons) throw new DomainError('insufficient balance for refund', 409);
    const transaction = await postWithClient(tx, {
      type: TransactionType.REFUND,
      externalRef: `refund:${request.id}`,
      userId: request.sellerId,
      status: TransactionStatus.CONFIRMED,
      amountCoupons: request.amountCoupons,
      legs: [{ fromAccountId: seller.id, toAccountId: buyer.id, amount: request.amountCoupons, asset: Asset.COUPON }],
    });
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
    if (request.sellerId !== input.sellerId) throw new DomainError('resource not found', 404);
    if (request.status !== RefundStatus.PENDING) throw new DomainError('refund is not pending', 409);
    return tx.refundRequest.update({
      where: { id: request.id },
      data: { status: RefundStatus.REJECTED, decisionNote: note, decidedAt: new Date() },
    });
  });
}
