'use server';

import { redirect } from 'next/navigation';
import { adminApiFetch, ApiResponseError } from '../../lib/api';
import { labels } from '../../labels';

export async function addAllowedEmailAction(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim();
  const role = String(formData.get('role') ?? '');
  try {
    await adminApiFetch('/admin/allowed-emails', {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    });
  } catch (error) {
    const message = error instanceof ApiResponseError ? error.message : labels.apiUnavailable;
    redirect(`/admins?flashType=error&flash=${encodeURIComponent(message)}`);
  }
  redirect(`/admins?flashType=success&flash=${encodeURIComponent(labels.emailAdded)}`);
}

export async function removeAllowedEmailAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  try {
    await adminApiFetch(`/admin/allowed-emails/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (error) {
    const message = error instanceof ApiResponseError ? error.message : labels.apiUnavailable;
    redirect(`/admins?flashType=error&flash=${encodeURIComponent(message)}`);
  }
  redirect(`/admins?flashType=success&flash=${encodeURIComponent(labels.emailRemoved)}`);
}
