import { ApiError } from '../api/client';
import type { Translations } from '../i18n/en';

export function mapApiError(error: unknown, t: Translations): string {
  if (!(error instanceof ApiError)) return t.unknownError;
  if (error.status === 413) return t.mediaTooLarge;
  if (error.status === 415) return t.unsupportedMedia;
  const messages: Record<string, string> = {
    identity_verification_required: t.identitySpendingRequired,
    'refund is already pending': t.refundAlreadyPending,
    'refund exceeds refundable amount': t.refundExceedsAmount,
    'transaction is not refundable': t.transactionNotRefundable,
    'insufficient balance for refund': t.insufficientRefundBalance,
    'insufficient charity balance': t.insufficientCharityBalance,
  };
  return messages[error.message] ?? error.message;
}
