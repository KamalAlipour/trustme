'use server';

import { redirect } from 'next/navigation';
import { labels } from '../../labels';
import { adminApiFetch, ApiResponseError } from '../../lib/api';

const fields = ['withdrawalBaseFeeBps', 'minimumWithdrawalMicroUsdt', 'autoApprovalLimitMicroUsdt'] as const;

export async function updateSettingsAction(formData: FormData): Promise<void> {
  const body = Object.fromEntries(fields.map((field) => [field, formData.get(field)]));
  for (const field of fields) {
    if (typeof body[field] !== 'string' || !/^(?:0|[1-9]\d*)$/.test(body[field])) {
      redirect(`/settings?errorField=${field}&error=${encodeURIComponent(labels.required)}`);
    }
  }
  try {
    await adminApiFetch('/admin/settings', { method: 'PATCH', body: JSON.stringify(body) });
  } catch (error) {
    if (error instanceof ApiResponseError) {
      const field = error.message.includes('fee bps')
        ? 'withdrawalBaseFeeBps'
        : fields.find((candidate) => error.message.includes(candidate)) ?? 'general';
      redirect(`/settings?errorField=${field}&error=${encodeURIComponent(error.message)}`);
    }
    throw error;
  }
  redirect('/settings');
}
