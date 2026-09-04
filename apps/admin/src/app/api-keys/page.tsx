import Link from 'next/link';
import { ApiKeyCreateForm } from '../../components/api-key-create-form';
import { Flash } from '../../components/flash';
import { NotPermitted, Shell } from '../../components/shell';
import { labels } from '../../labels';
import { ApiForbiddenError, adminApiFetch } from '../../lib/api';
import { requireAdminSession } from '../../lib/session';
import { revokeApiKeyAction } from './actions';

type ApiKeyRow = {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdBy: { username: string };
};

function date(value: string | null): string {
  return value === null ? '—' : new Date(value).toLocaleString();
}

function status(row: ApiKeyRow): string {
  if (row.revokedAt !== null) return labels.apiKeyRevoked;
  if (row.expiresAt !== null && new Date(row.expiresAt) <= new Date()) return labels.apiKeyExpired;
  return labels.apiKeyActive;
}

export default async function ApiKeysPage({ searchParams }: { searchParams: Promise<{ flash?: string; flashType?: string }> }) {
  const params = await searchParams;
  const session = await requireAdminSession();
  if (session.role !== 'ADMIN') return <Shell session={session}><NotPermitted /></Shell>;
  try {
    const rows = await adminApiFetch<ApiKeyRow[]>('/admin/api-keys');
    return (
      <Shell session={session}>
        <div className="space-y-6">
          <div className="flex items-center justify-between"><h1 className="text-2xl font-semibold">{labels.apiKeys}</h1><Link href="/api-keys/new-result">{labels.createApiKey}</Link></div>
          <Flash message={params.flash} type={params.flashType} />
          <ApiKeyCreateForm />
          <div className="overflow-x-auto rounded-lg border bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead><tr className="border-b bg-slate-50"><th className="p-3">{labels.apiKeyName}</th><th className="p-3">{labels.apiKeyPrefix}</th><th className="p-3">{labels.apiKeyScopes}</th><th className="p-3">{labels.apiKeyCreated}</th><th className="p-3">{labels.apiKeyExpires}</th><th className="p-3">{labels.apiKeyLastUsed}</th><th className="p-3">{labels.apiKeyStatus}</th><th className="p-3">{labels.actions}</th></tr></thead>
              <tbody>{rows.map((row) => <tr className="border-b last:border-0" key={row.id}><td className="p-3">{row.name}</td><td className="p-3 font-mono">{row.keyPrefix}…</td><td className="p-3">{row.scopes.join(', ')}</td><td className="p-3">{date(row.createdAt)}</td><td className="p-3">{date(row.expiresAt)}</td><td className="p-3">{date(row.lastUsedAt)}</td><td className="p-3">{status(row)}</td><td className="p-3">{row.revokedAt === null ? <form action={revokeApiKeyAction}><input type="hidden" name="id" value={row.id} /><button type="submit" className="text-red-700" title={labels.apiKeyRevokeConfirm}>{labels.apiKeyRevoke}</button></form> : '—'}</td></tr>)}</tbody>
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
