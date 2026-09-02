import { updateSettingsAction } from '../app/settings/actions';
import { labels } from '../labels';
import { bpsToPercent, microUsdtToDecimal } from '../lib/format';

type Settings = {
  withdrawalBaseFeeBps: string;
  minimumFeeMicroUsdt: string;
  minimumWithdrawalMicroUsdt: string;
  autoApprovalLimitMicroUsdt: string;
  requireIdentityForWithdrawal: boolean;
  identityRequiredCountries: string[];
};

export function SettingsForm({ settings, errorField, errorMessage }: Readonly<{ settings: Settings; errorField?: string | undefined; errorMessage?: string | undefined }>) {
  const fieldError = (field: string) => errorField === field ? errorMessage : undefined;
  return (
    <form action={updateSettingsAction} className="max-w-xl space-y-5 rounded-lg border bg-white p-6 shadow-sm">
      <label className="block">
        <span className="mb-1 block text-sm font-medium">{labels.withdrawalBaseFeeBps}</span>
        <div className="flex items-center gap-3"><input className="w-full" name="withdrawalBaseFeeBps" defaultValue={settings.withdrawalBaseFeeBps} inputMode="numeric" /><span className="whitespace-nowrap text-sm text-slate-500">{settings.withdrawalBaseFeeBps} {labels.feeEquivalent} {bpsToPercent(settings.withdrawalBaseFeeBps)}</span></div>
        {fieldError('withdrawalBaseFeeBps') ? <span className="mt-1 block text-sm text-red-700">{fieldError('withdrawalBaseFeeBps')}</span> : null}
      </label>
      <label className="flex items-center gap-3">
        <input type="checkbox" name="requireIdentityForWithdrawal" defaultChecked={settings.requireIdentityForWithdrawal} />
        <span className="text-sm font-medium">{labels.requireIdentityForWithdrawal}</span>
      </label>
      <label className="flex items-center gap-3">
        <input type="checkbox" name="identityRequiredCountries" value="IR" defaultChecked={settings.identityRequiredCountries.includes('IR')} />
        <span className="text-sm font-medium">{labels.identityRequiredBeforeSpendingIran}</span>
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium">{labels.minimumFeeMicroUsdt}</span>
        <input className="w-full" name="minimumFeeUsdt" defaultValue={microUsdtToDecimal(settings.minimumFeeMicroUsdt)} inputMode="decimal" />
        {fieldError('minimumFeeUsdt') ? <span className="mt-1 block text-sm text-red-700">{fieldError('minimumFeeUsdt')}</span> : null}
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium">{labels.minimumWithdrawalMicroUsdt}</span>
        <input className="w-full" name="minimumWithdrawalUsdt" defaultValue={microUsdtToDecimal(settings.minimumWithdrawalMicroUsdt)} inputMode="decimal" />
        {fieldError('minimumWithdrawalUsdt') ? <span className="mt-1 block text-sm text-red-700">{fieldError('minimumWithdrawalUsdt')}</span> : null}
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium">{labels.autoApprovalLimitMicroUsdt}</span>
        <input className="w-full" name="autoApprovalLimitUsdt" defaultValue={microUsdtToDecimal(settings.autoApprovalLimitMicroUsdt)} inputMode="decimal" />
        {fieldError('autoApprovalLimitUsdt') ? <span className="mt-1 block text-sm text-red-700">{fieldError('autoApprovalLimitUsdt')}</span> : null}
      </label>
      {errorField === undefined && errorMessage ? <p className="text-sm text-red-700">{errorMessage}</p> : null}
      <button type="submit" className="bg-blue-700 text-white hover:bg-blue-800">{labels.save}</button>
    </form>
  );
}
