import { approveIdentityReviewAction, rejectIdentityReviewAction } from '../app/identity-reviews/actions';
import { labels } from '../labels';
import { formatCompactDate } from '../lib/format';
import { canManageWithdrawals, type AdminRole } from '../lib/session';

export type IdentityReviewRow = {
  id: string;
  barcodeId: string;
  country: string;
  status: string;
  submittedAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  documentUrl: string | null;
  selfieUrl: string | null;
};

export function IdentityReviewTable({ rows, role }: Readonly<{ rows: IdentityReviewRow[]; role: AdminRole }>) {
  return (
    <div className="overflow-x-auto rounded-lg border bg-white shadow-sm">
      <table className="min-w-full text-left text-sm">
        <thead className="bg-slate-50">
          <tr>{[labels.barcode, labels.country, labels.submittedAt, labels.decidedAt, labels.document, labels.selfie, labels.status, labels.actions].map((label) => <th className="whitespace-nowrap px-4 py-3 font-medium" key={label}>{label}</th>)}</tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="px-4 py-3">{row.barcodeId}</td>
              <td className="px-4 py-3">{row.country}</td>
              <td className="whitespace-nowrap px-4 py-3">{formatCompactDate(row.submittedAt)}</td>
              <td className="whitespace-nowrap px-4 py-3">{row.decidedAt ? formatCompactDate(row.decidedAt) : '—'}</td>
              <td className="px-4 py-3">{row.documentUrl ? <img className="max-h-32 max-w-32 object-contain" src={`/api${row.documentUrl}`} alt={labels.document} /> : '—'}</td>
              <td className="px-4 py-3">{row.selfieUrl ? <img className="max-h-32 max-w-32 object-contain" src={`/api${row.selfieUrl}`} alt={labels.selfie} /> : '—'}</td>
              <td className="px-4 py-3">{row.status}{row.decisionNote ? ` — ${row.decisionNote}` : ''}</td>
              <td className="px-4 py-3">
                {canManageWithdrawals(role) && row.status === 'PENDING' ? (
                  <div className="flex min-w-48 flex-col gap-2">
                    <form action={approveIdentityReviewAction}><input type="hidden" name="id" value={row.id} /><button type="submit">{labels.approve}</button></form>
                    <form action={rejectIdentityReviewAction} className="flex gap-2"><input type="hidden" name="id" value={row.id} /><input name="note" placeholder={labels.rejectionNote} required /><button type="submit">{labels.reject}</button></form>
                  </div>
                ) : null}
              </td>
            </tr>
          ))}
          {rows.length === 0 ? <tr><td className="px-4 py-8 text-center text-slate-500" colSpan={8}>{labels.noRows}</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}
