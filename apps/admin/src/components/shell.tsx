import Link from 'next/link';
import { logoutAction } from '../app/logout/actions';
import { labels } from '../labels';
import type { AdminSession } from '../lib/session';

export function Shell({ children, session }: Readonly<{ children: React.ReactNode; session: AdminSession }>) {
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
            {session.role === 'ADMIN' ? <Link href="/settings">{labels.settings}</Link> : null}
            <span className="text-slate-500">{session.username} ({session.role})</span>
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
