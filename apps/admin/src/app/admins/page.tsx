import { Flash } from '../../components/flash';
import { NotPermitted, Shell } from '../../components/shell';
import { labels } from '../../labels';
import { ApiForbiddenError, adminApiFetch } from '../../lib/api';
import { requireAdminSession } from '../../lib/session';
import { addAllowedEmailAction, removeAllowedEmailAction } from './actions';

type AllowedEmailRow = {
  id: string;
  email: string;
  role: 'VIEWER' | 'APPROVER' | 'ADMIN';
  createdAt: string;
  createdBy: string | null;
};

function date(value: string): string {
  return new Date(value).toLocaleString();
}

export default async function AdminsPage({ searchParams }: { searchParams: Promise<{ flash?: string; flashType?: string }> }) {
  const params = await searchParams;
  const session = await requireAdminSession();
  if (session.role !== 'ADMIN') return <Shell session={session}><NotPermitted /></Shell>;
  try {
    const rows = await adminApiFetch<AllowedEmailRow[]>('/admin/allowed-emails');
    return (
      <Shell session={session}>
        <div className="space-y-6">
          <div><h1 className="text-2xl font-semibold">{labels.admins}</h1><p className="text-sm text-slate-600">{labels.allowedEmails}</p></div>
          <Flash message={params.flash} type={params.flashType} />
          <form action={addAllowedEmailAction} className="flex flex-wrap items-end gap-3 rounded-lg border bg-white p-4 shadow-sm">
            <label className="min-w-64 flex-1"><span className="mb-1 block text-sm font-medium">{labels.email}</span><input className="w-full" name="email" type="email" required /></label>
            <label><span className="mb-1 block text-sm font-medium">{labels.role}</span><select className="w-full" name="role" defaultValue="VIEWER"><option value="VIEWER">VIEWER</option><option value="APPROVER">APPROVER</option><option value="ADMIN">ADMIN</option></select></label>
            <button type="submit" className="bg-blue-700 text-white hover:bg-blue-800">{labels.addEmail}</button>
          </form>
          <div className="overflow-x-auto rounded-lg border bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead><tr className="border-b bg-slate-50"><th className="p-3">{labels.email}</th><th className="p-3">{labels.role}</th><th className="p-3">{labels.addedBy}</th><th className="p-3">{labels.createdAt}</th><th className="p-3">{labels.actions}</th></tr></thead>
              <tbody>{rows.map((row) => <tr className="border-b last:border-0" key={row.id}><td className="p-3">{row.email}</td><td className="p-3">{row.role}</td><td className="p-3">{row.createdBy ?? '—'}</td><td className="p-3">{date(row.createdAt)}</td><td className="p-3"><form action={removeAllowedEmailAction}><input type="hidden" name="id" value={row.id} /><button type="submit" className="text-red-700">{labels.remove}</button></form></td></tr>)}</tbody>
            </table>
          </div>
        </div>
      </Shell>
    );
  } catch (error) {
    if (error instanceof ApiForbiddenError) return <Shell session={session}><NotPermitted /></Shell>;
    throw error;
  }
}
