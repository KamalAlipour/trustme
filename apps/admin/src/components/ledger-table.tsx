import { labels } from '../labels';
import { formatDate } from '../lib/format';

type LedgerEntry = { id: string; fromAccountId: string; toAccountId: string; amount: string; asset: string; createdAt: string };
export type LedgerRow = {
  id: string;
  type: string;
  status: string;
  barcodeId: string | null;
  externalRef: string;
  amountUsdt: string;
  amountCoupons: string;
  feeUsdt: string;
  createdAt: string;
  entries: LedgerEntry[];
};

export function LedgerTable({ rows }: Readonly<{ rows: LedgerRow[] }>) {
  return (
    <div className="overflow-x-auto rounded-lg border bg-white shadow-sm">
      <table className="min-w-full text-left text-sm">
        <thead className="bg-slate-50">
          <tr>{[labels.transactionType, labels.status, labels.barcode, labels.externalReference, labels.usdt, labels.coupons, labels.createdAt, ''].map((label) => <th className="whitespace-nowrap px-4 py-3 font-medium" key={label || 'actions'}>{label}</th>)}</tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="px-4 py-3">{row.type}</td>
              <td className="px-4 py-3">{row.status}</td>
              <td className="px-4 py-3">{row.barcodeId ?? '—'}</td>
              <td className="px-4 py-3 font-mono text-xs">{row.externalRef}</td>
              <td className="px-4 py-3">{row.amountUsdt}</td>
              <td className="px-4 py-3">{row.amountCoupons}</td>
              <td className="whitespace-nowrap px-4 py-3">{formatDate(row.createdAt)}</td>
              <td className="px-4 py-3">
                <details>
                  <summary className="cursor-pointer">{labels.entries}</summary>
                  <ul className="mt-2 space-y-1 text-xs">
                    {row.entries.map((entry) => <li key={entry.id}>{entry.asset}: {entry.amount} ({entry.fromAccountId} → {entry.toAccountId})</li>)}
                  </ul>
                </details>
              </td>
            </tr>
          ))}
          {rows.length === 0 ? <tr><td className="px-4 py-8 text-center text-slate-500" colSpan={8}>{labels.noRows}</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}
