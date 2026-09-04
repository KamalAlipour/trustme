import { updateSettingsAction } from '../app/settings/actions';
import { identityCountryRegistry } from '@trustme/core';
import { labels } from '../labels';
import { bpsToPercent, microUsdtToDecimal } from '../lib/format';

type Settings = {
  withdrawalBaseFeeBps: string;
  minimumFeeMicroUsdt: string;
  minimumWithdrawalMicroUsdt: string;
  autoApprovalLimitMicroUsdt: string;
  requireIdentityForWithdrawal: boolean;
  identityRequiredCountries: string[];
  commissionFloorBps: number;
  commissionFloorByCountry: Array<{ country: string; bps: number }>;
  trainerCutBps: number;
};

export function SettingsForm({ settings, errorField, errorMessage }: Readonly<{ settings: Settings; errorField?: string | undefined; errorMessage?: string | undefined }>) {
  const fieldError = (field: string) => errorField === field ? errorMessage : undefined;
  const registeredCountries = new Set(identityCountryRegistry.map((country) => country.country));
  const extraCountries = [...new Set(settings.identityRequiredCountries.filter((country) => !registeredCountries.has(country)))];
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
      <fieldset className="space-y-2">
        <legend className="mb-1 block text-sm font-medium">{labels.identityRequiredBeforeSpending}</legend>
        {identityCountryRegistry.map((country) => (
          <label className="flex items-center gap-3" key={country.country}>
            <input type="checkbox" name="identityRequiredCountries" value={country.country} defaultChecked={settings.identityRequiredCountries.includes(country.country)} />
            <span className="text-sm">{country.country} — {country.providerLabel}</span>
          </label>
        ))}
        {extraCountries.map((country) => (
          <label className="flex items-center gap-3" key={country}>
            <input type="checkbox" name="identityRequiredCountries" value={country} defaultChecked />
            <span className="text-sm">{country}</span>
          </label>
        ))}
      </fieldset>
      <label className="block">
        <span className="mb-1 block text-sm font-medium">Commission floor (bps)</span>
        <input className="w-full" name="commissionFloorBps" defaultValue={settings.commissionFloorBps} inputMode="numeric" />
        {fieldError('commissionFloorBps') ? <span className="mt-1 block text-sm text-red-700">{fieldError('commissionFloorBps')}</span> : null}
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium">Commission floors by country (IR=300,NO=300)</span>
        <input className="w-full" name="commissionFloorByCountry" defaultValue={settings.commissionFloorByCountry.map((row) => `${row.country}=${row.bps}`).join(',')} />
        {fieldError('commissionFloorByCountry') ? <span className="mt-1 block text-sm text-red-700">{fieldError('commissionFloorByCountry')}</span> : null}
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium">Trainer cut (bps)</span>
        <input className="w-full" name="trainerCutBps" defaultValue={settings.trainerCutBps} inputMode="numeric" />
        {fieldError('trainerCutBps') ? <span className="mt-1 block text-sm text-red-700">{fieldError('trainerCutBps')}</span> : null}
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
