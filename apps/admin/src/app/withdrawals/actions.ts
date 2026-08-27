'use server';

import { redirect } from 'next/navigation';
import { adminApiFetch, ApiResponseError } from '../../lib/api';
import { labels } from '../../labels';

function errorRedirect(message: string): never {
  redirect(`/withdrawals?flashType=error&flash=${encodeURIComponent(message)}`);
}

function actionError(error: unknown): never {
  if (error instanceof ApiResponseError) errorRedirect(error.message);
  errorRedirect(labels.apiUnavailable);
}

export async function approveWithdrawalAction(formData: FormData): Promise<void> {
  try {
    await adminApiFetch(`/admin/withdrawals/${encodeURIComponent(String(formData.get('id') ?? ''))}/approve`, { method: 'POST' });
  } catch (error) {
    actionError(error);
  }
  redirect(`/withdrawals?flashType=success&flash=${encodeURIComponent(labels.approved)}`);
}

export async function rejectWithdrawalAction(formData: FormData): Promise<void> {
  try {
    await adminApiFetch(`/admin/withdrawals/${encodeURIComponent(String(formData.get('id') ?? ''))}/reject`, { method: 'POST' });
  } catch (error) {
    actionError(error);
  }
  redirect(`/withdrawals?flashType=success&flash=${encodeURIComponent(labels.rejected)}`);
}
