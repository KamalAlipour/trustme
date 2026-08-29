import { Flash } from '../../components/flash';
import { IdentityReviewTable, type IdentityReviewRow } from '../../components/identity-review-table';
import { NotPermitted, Shell } from '../../components/shell';
import { labels } from '../../labels';
import { ApiForbiddenError, adminApiFetch } from '../../lib/api';
import { requireAdminSession } from '../../lib/session';

type IdentityReviewResponse = { items: IdentityReviewRow[]; nextCursor: string | null };
const statuses = ['PENDING', 'APPROVED', 'REJECTED'];

export default async function IdentityReviewsPage({ searchParams }: { searchParams: Promise<{ status?: string; cursor?: string; flash?: string; flashType?: string }> }) {
  const params = await searchParams;
  const session = await requireAdminSession();
  const query = new URLSearchParams();
  if (params.status && statuses.includes(params.status)) query.set('status', params.status);
  if (params.cursor) query.set('cursor', params.cursor);
  try {
    const data = await adminApiFetch<IdentityReviewResponse>(`/admin/identity-reviews?${query.toString()}`);
    return (
      <Shell session={session}>
        <div className="space-y-5">
          <h1 className="text-2xl font-semibold">{labels.identityReviews}</h1>
          <Flash message={params.flash} type={params.flashType} />
          <form className="flex items-end gap-3" method="get">
            <label><span className="mb-1 block text-sm">{labels.status}</span><select name="status" defaultValue={params.status ?? ''}><option value="">{labels.allStatuses}</option>{statuses.map((status) => <option key={status} value={status}>{status}</option>)}</select></label>
            <button type="submit">{labels.filter}</button>
          </form>
          <IdentityReviewTable rows={[...data.items].sort((left, right) => Number(right.status === 'PENDING') - Number(left.status === 'PENDING'))} role={session.role} />
          {data.nextCursor ? <a href={`/identity-reviews?${new URLSearchParams({ ...(params.status ? { status: params.status } : {}), cursor: data.nextCursor })}`}>{labels.next}</a> : null}
        </div>
      </Shell>
    );
  } catch (error) {
    if (error instanceof ApiForbiddenError) return <Shell session={session}><NotPermitted /></Shell>;
    throw error;
  }
}
