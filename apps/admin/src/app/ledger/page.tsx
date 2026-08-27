import { NotPermitted, Shell } from '../../components/shell';
import { LedgerTable, type LedgerRow } from '../../components/ledger-table';
import { labels } from '../../labels';
import { ApiForbiddenError, adminApiFetch } from '../../lib/api';
import { requireAdminSession } from '../../lib/session';
import { transactionTypes } from '../../labels';

type LedgerResponse = { items: LedgerRow[]; nextCursor: string | null };

export default async function LedgerPage({ searchParams }: { searchParams: Promise<{ search?: string; type?: string; from?: string; to?: string; cursor?: string }> }) {
  const params = await searchParams;
  const session = await requireAdminSession();
  const query = new URLSearchParams();
  for (const field of ['search', 'type', 'from', 'to', 'cursor'] as const) if (params[field]) query.set(field, params[field] as string);
  try {
    const data = await adminApiFetch<LedgerResponse>(`/admin/ledger?${query.toString()}`);
    return (
      <Shell session={session}>
        <div className="space-y-5">
          <h1 className="text-2xl font-semibold">{labels.ledger}</h1>
          <form className="flex flex-wrap items-end gap-3" method="get">
            <label><span className="mb-1 block text-sm">{labels.search}</span><input name="search" defaultValue={params.search} /></label>
            <label><span className="mb-1 block text-sm">{labels.transactionType}</span><select name="type" defaultValue={params.type ?? ''}><option value="">{labels.allTypes}</option>{transactionTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
            <label><span className="mb-1 block text-sm">{labels.from}</span><input name="from" type="datetime-local" defaultValue={params.from} /></label>
            <label><span className="mb-1 block text-sm">{labels.to}</span><input name="to" type="datetime-local" defaultValue={params.to} /></label>
            <button type="submit">{labels.filter}</button>
          </form>
          <LedgerTable rows={data.items} />
          {data.nextCursor ? <a href={`/ledger?${new URLSearchParams({ ...(params.search ? { search: params.search } : {}), cursor: data.nextCursor })}`}>{labels.next}</a> : null}
        </div>
      </Shell>
    );
  } catch (error) {
    if (error instanceof ApiForbiddenError) return <Shell session={session}><NotPermitted /></Shell>;
    throw error;
  }
}
