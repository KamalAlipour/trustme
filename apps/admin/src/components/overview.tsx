import { labels } from '../labels';

export type OverviewData = {
  vaultUsdt: string;
  couponsInCirculation: string;
  feesCollectedUsdt: string;
  withdrawalPendingUsdt: string;
  dustUsdt: string;
  solvency: {
    custodyUsdt: string;
    obligationsUsdt: string;
    surplusUsdt: string;
    isSolvent: boolean;
    components: { vaultUsdt: string; withdrawalPendingUsdt: string; feesUsdt: string; couponsUsdt: string; dustUsdt: string };
  };
  transactionCount24hByType: Record<string, number>;
  chain: { available: boolean; headBlock?: number; nextBlock?: string; lag?: string };
  hotWallet: { available: boolean; usdt?: string; nativeWei?: string };
  demo: { couponsInCirculation: string; userCount: number };
  commissionNetworkAverageBps: number;
};

export function availabilityLabel(available: boolean): string {
  return available ? labels.available : labels.unavailable;
}

function StatCard({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="rounded-lg border bg-white p-5 shadow-sm">
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
    </div>
  );
}

export function Overview({ data }: Readonly<{ data: OverviewData }>) {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">{labels.overview}</h1>
        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <StatCard label={labels.vaultUsdt} value={data.vaultUsdt} />
          <StatCard label={labels.couponsInCirculation} value={data.couponsInCirculation} />
          <StatCard label={labels.feesCollected} value={data.feesCollectedUsdt} />
          <StatCard label={labels.withdrawalPending} value={data.withdrawalPendingUsdt} />
          <StatCard label={labels.dust} value={data.dustUsdt} />
          <StatCard label={labels.commissionNetworkAverage} value={`${data.commissionNetworkAverageBps / 100}%`} />
          <div className={`rounded-lg border p-5 shadow-sm ${data.solvency.isSolvent ? 'border-emerald-300 bg-emerald-50' : 'border-red-300 bg-red-50'}`}>
            <p className="text-sm text-slate-500">{labels.solvencySurplus}</p>
            <p className="mt-2 text-2xl font-semibold">{data.solvency.surplusUsdt}</p>
            <p className="mt-1 text-sm font-medium">{data.solvency.isSolvent ? labels.solvent : labels.insolvent}</p>
          </div>
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <StatCard label={labels.custody} value={data.solvency.custodyUsdt} />
          <StatCard label={labels.obligations} value={data.solvency.obligationsUsdt} />
        </div>
        <section className="mt-4 rounded-lg border border-slate-300 bg-slate-50 p-5 shadow-sm">
          <h2 className="text-lg font-semibold">{labels.demoData}</h2>
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <StatCard label={labels.demoCouponsInCirculation} value={data.demo.couponsInCirculation} />
            <StatCard label={labels.demoUsers} value={String(data.demo.userCount)} />
          </div>
        </section>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-lg border bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">{labels.transactions24h}</h2>
          <div className="mt-4 divide-y">
            {Object.entries(data.transactionCount24hByType).map(([type, count]) => (
              <div className="flex justify-between py-2" key={type}>
                <span>{type}</span>
                <span>{count}</span>
              </div>
            ))}
          </div>
        </section>
        <section className="rounded-lg border bg-white p-5 shadow-sm">
          <div className="grid gap-6 md:grid-cols-2">
            <div>
              <h2 className="text-lg font-semibold">{labels.chain}</h2>
              {data.chain.available ? (
                <dl className="mt-3 space-y-2 text-sm">
                  <div className="flex justify-between gap-3"><dt>{labels.headBlock}</dt><dd>{data.chain.headBlock}</dd></div>
                  <div className="flex justify-between gap-3"><dt>{labels.nextBlock}</dt><dd>{data.chain.nextBlock}</dd></div>
                  <div className="flex justify-between gap-3"><dt>{labels.lag}</dt><dd>{data.chain.lag}</dd></div>
                </dl>
              ) : <p className="mt-3 text-sm text-slate-500">{labels.unavailable}</p>}
            </div>
            <div>
              <h2 className="text-lg font-semibold">{labels.hotWallet}</h2>
              {data.hotWallet.available ? (
                <dl className="mt-3 space-y-2 text-sm">
                  <div className="flex justify-between gap-3"><dt>{labels.usdt}</dt><dd>{data.hotWallet.usdt}</dd></div>
                  <div className="flex justify-between gap-3"><dt>{labels.nativeBalance}</dt><dd>{data.hotWallet.nativeWei}</dd></div>
                </dl>
              ) : <p className="mt-3 text-sm text-slate-500">{labels.unavailable}</p>}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
