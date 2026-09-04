'use server';

import { redirect } from 'next/navigation';
import { adminApiFetch, ApiResponseError } from '../../lib/api';
import { labels } from '../../labels';

export type ApiKeyActionState = { rawKey?: string; error?: string };

export async function createApiKeyAction(_previous: ApiKeyActionState, formData: FormData): Promise<ApiKeyActionState> {
  const name = String(formData.get('name') ?? '').trim();
  const scopes = formData.getAll('scopes').filter((value): value is string => typeof value === 'string');
  const expiresAt = String(formData.get('expiresAt') ?? '').trim();
  try {
    const result = await adminApiFetch<{ rawKey: string }>('/admin/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name, scopes, ...(expiresAt === '' ? {} : { expiresAt: new Date(`${expiresAt}T23:59:59.999Z`).toISOString() }) }),
    });
    return { rawKey: result.rawKey };
  } catch (error) {
    if (error instanceof ApiResponseError) return { error: error.message };
    return { error: labels.apiKeyCreateFailed };
  }
}

export async function revokeApiKeyAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  try {
    await adminApiFetch(`/admin/api-keys/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
  } catch (error) {
    const message = error instanceof ApiResponseError ? error.message : labels.apiKeyRevokeFailed;
    redirect(`/api-keys?flashType=error&flash=${encodeURIComponent(message)}`);
  }
  redirect(`/api-keys?flashType=success&flash=${encodeURIComponent(labels.apiKeyRevokedSuccess)}`);
}
