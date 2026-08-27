import { NotPermitted, Shell } from '../../components/shell';
import { WithdrawalTable, type WithdrawalRow } from '../../components/withdrawal-table';
import { labels, statusLabels } from '../../labels';
import { ApiForbiddenError, adminApiFetch } from '../../lib/api';
import { requireAdminSession } from '../../lib/session';
import { Flash } from '../../components/flash';

type WithdrawalResponse = { items: WithdrawalRow[]; nextCursor: string | null };
const statuses = Object.keys(statusLabels);

export default async function WithdrawalsPage({ searchParams }: { searchParams: Promise<{ status?: string; cursor?: string; flash?: string; flashType?: string }> }) {
  const params = await searchParams;
  const session = await requireAdminSession();
  const query = new URLSearchParams();
  if (params.status && statuses.includes(params.status)) query.set('status', params.status);
  if (params.cursor) query.set('cursor', params.cursor);
  try {
    const data = await adminApiFetch<WithdrawalResponse>(`/admin/withdrawals?${query.toString()}`);
    return (
      <Shell session={session}>
        <div className="space-y-5">
          <h1 className="text-2xl font-semibold">{labels.withdrawals}</h1>
          <Flash message={params.flash} type={params.flashType} />
          <form className="flex items-end gap-3" method="get">
            <label><span className="mb-1 block text-sm">{labels.status}</span><select name="status" defaultValue={params.status ?? ''}><option value="">{labels.allStatuses}</option>{statuses.map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}</select></label>
            <button type="submit">{labels.filter}</button>
          </form>
          <WithdrawalTable rows={data.items} role={session.role} />
          {data.nextCursor ? <a href={`/withdrawals?${new URLSearchParams({ ...(params.status ? { status: params.status } : {}), cursor: data.nextCursor })}`}>{labels.next}</a> : null}
        </div>
      </Shell>
    );
  } catch (error) {
    if (error instanceof ApiForbiddenError) return <Shell session={session}><NotPermitted /></Shell>;
    throw error;
  }
}
