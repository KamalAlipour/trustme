import type { Transaction } from '../api/types';

export function refundableRemainder(transaction: Transaction): string {
  try {
    const purchase = BigInt(transaction.amountCoupons);
    const refunded = transaction.refund === null ? 0n : BigInt(transaction.refund.amountCoupons);
    return purchase > refunded ? (purchase - refunded).toString() : '0';
  } catch {
    return '0';
  }
}

export function canRequestRefund(transaction: Transaction): boolean {
  return transaction.direction === 'out' &&
    transaction.refundableTransactionId !== null &&
    transaction.refund?.status !== 'PENDING' &&
    (transaction.refund === null || refundableRemainder(transaction) !== '0');
}
