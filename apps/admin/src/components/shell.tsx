import Link from 'next/link';
import { logoutAction } from '../app/logout/actions';
import { labels } from '../labels';

export function Shell({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="min-h-screen">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <Link href="/" className="font-semibold text-slate-900">
            {labels.appName}
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/">{labels.overview}</Link>
            <Link href="/withdrawals">{labels.withdrawals}</Link>
            <Link href="/ledger">{labels.ledger}</Link>
            <Link href="/settings">{labels.settings}</Link>
            <form action={logoutAction}>
              <button type="submit">{labels.logout}</button>
            </form>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
    </div>
  );
}

export function NotPermitted() {
  return <div className="rounded border border-amber-300 bg-amber-50 p-6">{labels.notPermitted}</div>;
}
