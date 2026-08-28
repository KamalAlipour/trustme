import { NotPermitted, Shell } from '../../components/shell';
import { SettingsForm } from '../../components/settings-form';
import { labels } from '../../labels';
import { ApiForbiddenError, adminApiFetch } from '../../lib/api';
import { canEditSettings, requireAdminSession } from '../../lib/session';
import { Flash } from '../../components/flash';

type Settings = { withdrawalBaseFeeBps: string; minimumFeeMicroUsdt: string; minimumWithdrawalMicroUsdt: string; autoApprovalLimitMicroUsdt: string };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ errorField?: string; error?: string; flash?: string; flashType?: string }> }) {
  const params = await searchParams;
  const session = await requireAdminSession();
  if (!canEditSettings(session.role)) return <Shell session={session}><NotPermitted /></Shell>;
  try {
    const settings = await adminApiFetch<Settings>('/admin/settings');
    return <Shell session={session}><div className="space-y-5"><h1 className="text-2xl font-semibold">{labels.settings}</h1><Flash message={params.flash} type={params.flashType} /><SettingsForm settings={settings} errorField={params.errorField} errorMessage={params.error} /></div></Shell>;
  } catch (error) {
    if (error instanceof ApiForbiddenError) return <Shell session={session}><NotPermitted /></Shell>;
    throw error;
  }
}
