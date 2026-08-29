'use server';

import { redirect } from 'next/navigation';
import { adminApiFetch, ApiResponseError } from '../../lib/api';
import { labels } from '../../labels';

function errorRedirect(message: string): never {
  redirect(`/identity-reviews?flashType=error&flash=${encodeURIComponent(message)}`);
}

function actionError(error: unknown): never {
  if (error instanceof ApiResponseError) errorRedirect(error.message);
  errorRedirect(labels.apiUnavailable);
}

export async function approveIdentityReviewAction(formData: FormData): Promise<void> {
  try {
    await adminApiFetch(`/admin/identity-reviews/${encodeURIComponent(String(formData.get('id') ?? ''))}/approve`, { method: 'POST' });
  } catch (error) {
    actionError(error);
  }
  redirect(`/identity-reviews?flashType=success&flash=${encodeURIComponent(labels.identityReviewApproved)}`);
}

export async function rejectIdentityReviewAction(formData: FormData): Promise<void> {
  try {
    await adminApiFetch(`/admin/identity-reviews/${encodeURIComponent(String(formData.get('id') ?? ''))}/reject`, {
      method: 'POST',
      body: JSON.stringify({ note: String(formData.get('note') ?? '') }),
    });
  } catch (error) {
    actionError(error);
  }
  redirect(`/identity-reviews?flashType=success&flash=${encodeURIComponent(labels.identityReviewRejected)}`);
}
