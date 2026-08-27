import type { Transaction } from '../api/types';

export function canRequestRefund(transaction: Transaction): boolean {
  return transaction.direction === 'out' &&
    transaction.refundableTransactionId !== null &&
    transaction.refund === null;
}
