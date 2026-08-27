import { Overview, type OverviewData } from '../components/overview';
import { NotPermitted, Shell } from '../components/shell';
import { ApiForbiddenError, adminApiFetch } from '../lib/api';

export default async function OverviewPage() {
  try {
    const data = await adminApiFetch<OverviewData>('/admin/overview');
    return <Shell><Overview data={data} /></Shell>;
  } catch (error) {
    if (error instanceof ApiForbiddenError) return <Shell><NotPermitted /></Shell>;
    throw error;
  }
}
