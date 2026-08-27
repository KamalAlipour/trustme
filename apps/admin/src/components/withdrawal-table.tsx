import { approveWithdrawalAction, rejectWithdrawalAction } from '../app/withdrawals/actions';
import { labels, statusLabels } from '../labels';
import { formatDate, truncateHash } from '../lib/format';
import { canApproveWithdrawal, canRejectWithdrawal } from './withdrawal-rules';
export { canApproveWithdrawal, canRejectWithdrawal } from './withdrawal-rules';

export type WithdrawalRow = {
  id: string;
  barcodeId: string;
  couponsGross: string;
  feeUsdt: string;
  netUsdt: string;
  destinationAddress: string;
  status: string;
  chainTxHash: string | null;
  createdAt: string;
  broadcastedAt: string | null;
};

export function WithdrawalTable({ rows }: Readonly<{ rows: WithdrawalRow[] }>) {
  return (
    <div className="overflow-x-auto rounded-lg border bg-white shadow-sm">
      <table className="min-w-full text-left text-sm">
        <thead className="bg-slate-50">
          <tr>{[labels.barcode, labels.grossCoupons, labels.fee, labels.net, labels.destination, labels.status, labels.chainTxHash, labels.createdAt, ''].map((label) => <th className="whitespace-nowrap px-4 py-3 font-medium" key={label}>{label}</th>)}</tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="px-4 py-3">{row.barcodeId}</td>
              <td className="px-4 py-3">{row.couponsGross}</td>
              <td className="px-4 py-3">{row.feeUsdt}</td>
              <td className="px-4 py-3">{row.netUsdt}</td>
              <td className="px-4 py-3 font-mono text-xs">{row.destinationAddress}</td>
              <td className="px-4 py-3">{statusLabels[row.status] ?? row.status}</td>
              <td className="px-4 py-3">
                {row.chainTxHash ? <a href={`https://polygonscan.com/tx/${row.chainTxHash}`} rel="noreferrer" target="_blank">{truncateHash(row.chainTxHash)}</a> : '—'}
              </td>
              <td className="whitespace-nowrap px-4 py-3">{formatDate(row.createdAt)}</td>
              <td className="whitespace-nowrap px-4 py-3">
                <div className="flex gap-2">
                  {canApproveWithdrawal(row) ? <form action={approveWithdrawalAction}><input type="hidden" name="id" value={row.id} /><button type="submit">{labels.approve}</button></form> : null}
                  {canRejectWithdrawal(row) ? <form action={rejectWithdrawalAction}><input type="hidden" name="id" value={row.id} /><button type="submit">{labels.reject}</button></form> : null}
                </div>
              </td>
            </tr>
          ))}
          {rows.length === 0 ? <tr><td className="px-4 py-8 text-center text-slate-500" colSpan={9}>{labels.noRows}</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}
