import { ApiError } from '../api/client';
import { fa } from '../i18n/fa';

export function mapApiError(error: unknown): string {
  if (!(error instanceof ApiError)) return fa.unknownError;
  if (error.status === 413) return 'حجم مدرک بیش از حد مجاز است.';
  if (error.status === 415) return 'نوع مدرک پشتیبانی نمی‌شود.';
  const messages: Record<string, string> = {
    'refund is already pending': 'برای این خرید یک درخواست مرجوعی در حال بررسی وجود دارد.',
    'refund exceeds refundable amount': 'مبلغ مرجوعی از مبلغ قابل بازپرداخت بیشتر است.',
    'transaction is not refundable': 'این تراکنش قابل بازپرداخت نیست.',
    'insufficient balance for refund': 'موجودی کوپن برای بازپرداخت کافی نیست.',
    'insufficient charity balance': 'موجودی خیریه کافی نیست.',
  };
  return messages[error.message] ?? error.message;
}
