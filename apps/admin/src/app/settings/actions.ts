'use server';

import { redirect } from 'next/navigation';
import { labels } from '../../labels';
import { adminApiFetch, ApiResponseError } from '../../lib/api';
import { decimalUsdtToMicro } from '../../lib/format';

const fields = ['withdrawalBaseFeeBps', 'minimumFeeUsdt', 'minimumWithdrawalUsdt', 'autoApprovalLimitUsdt', 'commissionFloorBps', 'commissionFloorByCountry', 'trainerCutBps', 'displayUnitEnSingular', 'displayUnitEnPlural', 'displayUnitFa'] as const;

export async function updateSettingsAction(formData: FormData): Promise<void> {
  const values = Object.fromEntries(fields.map((field) => [field, formData.get(field)])) as Record<typeof fields[number], FormDataEntryValue | null>;
  for (const field of fields) {
    if (typeof values[field] !== 'string') {
      redirect(`/settings?errorField=${field}&error=${encodeURIComponent(labels.required)}`);
    }
  }
  let body: Record<string, string | number | boolean | string[] | Array<{ country: string; bps: number }> | { en: { singular: string; plural: string }; fa: string }>;
  try {
    const minimumWithdrawalMicroUsdt = decimalUsdtToMicro(values.minimumWithdrawalUsdt as string);
    const minimumFeeMicroUsdt = decimalUsdtToMicro(values.minimumFeeUsdt as string);
    const autoApprovalLimitMicroUsdt = decimalUsdtToMicro(values.autoApprovalLimitUsdt as string);
    body = {
      withdrawalBaseFeeBps: values.withdrawalBaseFeeBps as string,
      minimumFeeMicroUsdt,
      minimumWithdrawalMicroUsdt,
      autoApprovalLimitMicroUsdt,
      requireIdentityForWithdrawal: formData.get('requireIdentityForWithdrawal') === 'on',
      identityRequiredCountries: formData.getAll('identityRequiredCountries').filter((value): value is string => typeof value === 'string'),
      commissionFloorBps: Number(formData.get('commissionFloorBps') ?? 300),
      commissionFloorByCountry: String(formData.get('commissionFloorByCountry') ?? 'IR=300').split(',').filter(Boolean).map((entry) => {
        const [country, bps] = entry.trim().split('=');
        return { country: country!.toUpperCase(), bps: Number(bps) };
      }),
      trainerCutBps: Number(formData.get('trainerCutBps') ?? 2000),
      displayUnit: {
        en: {
          singular: values.displayUnitEnSingular as string,
          plural: values.displayUnitEnPlural as string,
        },
        fa: values.displayUnitFa as string,
      },
    };
  } catch {
    const invalidField = !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(values.minimumFeeUsdt as string)
      ? 'minimumFeeUsdt'
      : !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(values.minimumWithdrawalUsdt as string)
        ? 'minimumWithdrawalUsdt'
        : 'autoApprovalLimitUsdt';
    redirect(`/settings?errorField=${invalidField}&error=${encodeURIComponent(labels.invalidAmount)}`);
  }
  try {
    await adminApiFetch('/admin/settings', { method: 'PATCH', body: JSON.stringify(body) });
  } catch (error) {
    if (error instanceof ApiResponseError) {
      const field = error.fields[0]?.path;
      const message = error.fields[0]?.message;
      const fieldQuery = field === undefined
        ? ''
        : `&errorField=${encodeURIComponent(field)}&error=${encodeURIComponent(message ?? labels.validationFailed)}`;
      const banner = error.fields.length > 0 ? labels.validationFailed : error.message;
      redirect(`/settings?flashType=error&flash=${encodeURIComponent(banner)}${fieldQuery}`);
    }
    redirect(`/settings?flashType=error&flash=${encodeURIComponent(labels.apiUnavailable)}`);
  }
  redirect(`/settings?flashType=success&flash=${encodeURIComponent(labels.saved)}`);
}
