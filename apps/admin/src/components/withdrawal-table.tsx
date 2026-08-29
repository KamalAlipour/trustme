import { approveWithdrawalAction, rejectWithdrawalAction } from '../app/withdrawals/actions';
import { labels, statusLabels } from '../labels';
import { formatCompactDate, truncateAddress, truncateHash } from '../lib/format';
import { canManageWithdrawals, type AdminRole } from '../lib/session';
import { canApproveWithdrawal, canRejectWithdrawal } from './withdrawal-rules';
export { canApproveWithdrawal, canRejectWithdrawal } from './withdrawal-rules';

export type WithdrawalRow = {
  id: string;
  barcodeId: string;
  country: string | null;
  identityVerificationStatus: string;
  couponsGross: string;
  feeUsdt: string;
  netUsdt: string;
  destinationAddress: string;
  status: string;
  chainTxHash: string | null;
  createdAt: string;
  broadcastedAt: string | null;
};

export function WithdrawalTable({ rows, role }: Readonly<{ rows: WithdrawalRow[]; role: AdminRole }>) {
  return (
    <div className="overflow-x-auto rounded-lg border bg-white shadow-sm">
      <table className="min-w-full text-left text-sm">
        <thead className="bg-slate-50">
          <tr>{[labels.barcode, labels.country, labels.identityVerificationStatus, labels.grossCoupons, labels.fee, labels.net, labels.destination, labels.status, labels.chainTxHash, labels.createdAt, labels.actions].map((label) => <th className="whitespace-nowrap px-4 py-3 font-medium" key={label}>{label}</th>)}</tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="px-4 py-3">{row.barcodeId}</td>
              <td className="px-4 py-3">{row.country ?? '—'}</td>
              <td className="px-4 py-3">{row.identityVerificationStatus}</td>
              <td className="px-4 py-3">{row.couponsGross}</td>
              <td className="px-4 py-3">{row.feeUsdt}</td>
              <td className="px-4 py-3">{row.netUsdt}</td>
              <td className="px-4 py-3 font-mono text-xs" title={row.destinationAddress}>{truncateAddress(row.destinationAddress)}</td>
              <td className="px-4 py-3">{statusLabels[row.status] ?? row.status}</td>
              <td className="px-4 py-3">
                {row.chainTxHash ? <a href={`https://polygonscan.com/tx/${row.chainTxHash}`} rel="noreferrer" target="_blank">{truncateHash(row.chainTxHash)}</a> : '—'}
              </td>
              <td className="whitespace-nowrap px-4 py-3">{formatCompactDate(row.createdAt)}</td>
              <td className="sticky right-0 whitespace-nowrap bg-white px-4 py-3 shadow-[-4px_0_8px_-6px_rgba(0,0,0,0.4)]">
                <div className="flex gap-2">
                  {canManageWithdrawals(role) && canApproveWithdrawal(row) ? <form action={approveWithdrawalAction}><input type="hidden" name="id" value={row.id} /><button type="submit">{labels.approve}</button></form> : null}
                  {canManageWithdrawals(role) && canRejectWithdrawal(row) ? <form action={rejectWithdrawalAction}><input type="hidden" name="id" value={row.id} /><button type="submit">{labels.reject}</button></form> : null}
                </div>
              </td>
            </tr>
          ))}
          {rows.length === 0 ? <tr><td className="px-4 py-8 text-center text-slate-500" colSpan={11}>{labels.noRows}</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}
