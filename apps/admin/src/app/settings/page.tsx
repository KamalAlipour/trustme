import { NotPermitted, Shell } from '../../components/shell';
import { SettingsForm } from '../../components/settings-form';
import { labels } from '../../labels';
import { ApiForbiddenError, adminApiFetch } from '../../lib/api';

type Settings = { withdrawalBaseFeeBps: string; minimumWithdrawalMicroUsdt: string; autoApprovalLimitMicroUsdt: string };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ errorField?: string; error?: string }> }) {
  const params = await searchParams;
  try {
    const settings = await adminApiFetch<Settings>('/admin/settings');
    return <Shell><div className="space-y-5"><h1 className="text-2xl font-semibold">{labels.settings}</h1><SettingsForm settings={settings} errorField={params.errorField} errorMessage={params.error} /></div></Shell>;
  } catch (error) {
    if (error instanceof ApiForbiddenError) return <Shell><NotPermitted /></Shell>;
    throw error;
  }
}
