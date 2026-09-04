import Link from 'next/link';
import { ApiKeyCreateForm } from '../../../components/api-key-create-form';
import { NotPermitted, Shell } from '../../../components/shell';
import { labels } from '../../../labels';
import { requireAdminSession } from '../../../lib/session';

export default async function NewApiKeyPage() {
  const session = await requireAdminSession();
  if (session.role !== 'ADMIN') return <Shell session={session}><NotPermitted /></Shell>;
  return <Shell session={session}><div className="max-w-xl space-y-4"><Link href="/api-keys">← {labels.apiKeyBack}</Link><ApiKeyCreateForm /></div></Shell>;
}
