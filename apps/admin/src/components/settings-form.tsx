import { updateSettingsAction } from '../app/settings/actions';
import { labels } from '../labels';

type Settings = {
  withdrawalBaseFeeBps: string;
  minimumWithdrawalMicroUsdt: string;
  autoApprovalLimitMicroUsdt: string;
};

export function SettingsForm({ settings, errorField, errorMessage }: Readonly<{ settings: Settings; errorField?: string | undefined; errorMessage?: string | undefined }>) {
  const fieldError = (field: string) => errorField === field ? errorMessage : undefined;
  return (
    <form action={updateSettingsAction} className="max-w-xl space-y-5 rounded-lg border bg-white p-6 shadow-sm">
      {(['withdrawalBaseFeeBps', 'minimumWithdrawalMicroUsdt', 'autoApprovalLimitMicroUsdt'] as const).map((field) => (
        <label className="block" key={field}>
          <span className="mb-1 block text-sm font-medium">{labels[field]}</span>
          <input className="w-full" name={field} defaultValue={settings[field]} inputMode="numeric" />
          {fieldError(field) ? <span className="mt-1 block text-sm text-red-700">{fieldError(field)}</span> : null}
        </label>
      ))}
      {errorField === undefined && errorMessage ? <p className="text-sm text-red-700">{errorMessage}</p> : null}
      <button type="submit" className="bg-blue-700 text-white hover:bg-blue-800">{labels.save}</button>
    </form>
  );
}
