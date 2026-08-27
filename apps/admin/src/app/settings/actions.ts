'use server';

import { redirect } from 'next/navigation';
import { labels } from '../../labels';
import { adminApiFetch, ApiResponseError } from '../../lib/api';
import { decimalUsdtToMicro } from '../../lib/format';

const fields = ['withdrawalBaseFeeBps', 'minimumWithdrawalUsdt', 'autoApprovalLimitUsdt'] as const;

export async function updateSettingsAction(formData: FormData): Promise<void> {
  const values = Object.fromEntries(fields.map((field) => [field, formData.get(field)])) as Record<typeof fields[number], FormDataEntryValue | null>;
  for (const field of fields) {
    if (typeof values[field] !== 'string') {
      redirect(`/settings?errorField=${field}&error=${encodeURIComponent(labels.required)}`);
    }
  }
  let body: Record<string, string>;
  try {
    const minimumWithdrawalMicroUsdt = decimalUsdtToMicro(values.minimumWithdrawalUsdt as string);
    const autoApprovalLimitMicroUsdt = decimalUsdtToMicro(values.autoApprovalLimitUsdt as string);
    body = {
      withdrawalBaseFeeBps: values.withdrawalBaseFeeBps as string,
      minimumWithdrawalMicroUsdt,
      autoApprovalLimitMicroUsdt,
    };
  } catch {
    const invalidField = !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(values.minimumWithdrawalUsdt as string)
      ? 'minimumWithdrawalUsdt'
      : 'autoApprovalLimitUsdt';
    redirect(`/settings?errorField=${invalidField}&error=${encodeURIComponent(labels.invalidAmount)}`);
  }
  try {
    await adminApiFetch('/admin/settings', { method: 'PATCH', body: JSON.stringify(body) });
  } catch (error) {
    if (error instanceof ApiResponseError) {
      const field = error.message.includes('fee bps')
        ? 'withdrawalBaseFeeBps'
        : error.message.includes('minimum') ? 'minimumWithdrawalUsdt'
          : error.message.includes('auto') ? 'autoApprovalLimitUsdt' : 'general';
      redirect(`/settings?errorField=${field}&error=${encodeURIComponent(error.message)}&flashType=error&flash=${encodeURIComponent(error.message)}`);
    }
    redirect(`/settings?flashType=error&flash=${encodeURIComponent(labels.apiUnavailable)}`);
  }
  redirect(`/settings?flashType=success&flash=${encodeURIComponent(labels.saved)}`);
}
