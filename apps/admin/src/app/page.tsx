import { Overview, type OverviewData } from '../components/overview';
import { NotPermitted, Shell } from '../components/shell';
import { ApiForbiddenError, adminApiFetch } from '../lib/api';
import { requireAdminSession } from '../lib/session';

export default async function OverviewPage() {
  const session = await requireAdminSession();
  try {
    const data = await adminApiFetch<OverviewData>('/admin/overview');
    return <Shell session={session}><Overview data={data} /></Shell>;
  } catch (error) {
    if (error instanceof ApiForbiddenError) return <Shell session={session}><NotPermitted /></Shell>;
    throw error;
  }
}
