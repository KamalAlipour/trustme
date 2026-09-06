import { describe, expect, it, vi } from 'vitest';
import { availabilityLabel } from './components/overview';
import { canRejectWithdrawal } from './components/withdrawal-rules';
import { Flash } from './components/flash';
import { labels } from './labels';
import { canManageWithdrawals } from './lib/session';
import { truncateAddress } from './lib/format';

const cookieValue = vi.hoisted(() => ({ value: 'cookie-token' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: cookieValue.value }) }),
}));
vi.mock('./config', () => ({
  config: { trustmeApiUrl: 'http://localhost', nodeEnv: 'test' },
  secureCookies: false,
}));

describe('admin UI rules', () => {
  it('labels unavailable chain data explicitly', () => {
    expect(availabilityLabel(false)).toBe(labels.unavailable);
  });

  it('does not offer rejection for chain-hashed withdrawals', () => {
    expect(canRejectWithdrawal({ status: 'PROCESSING', chainTxHash: '0xhash' })).toBe(false);
    expect(canRejectWithdrawal({ status: 'PENDING_APPROVAL', chainTxHash: null })).toBe(true);
  });

  it('middle-truncates long destination addresses', () => {
    expect(truncateAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x12345678…12345678');
  });

  it('gates withdrawal actions by role', () => {
    expect(canManageWithdrawals('VIEWER')).toBe(false);
    expect(canManageWithdrawals('APPROVER')).toBe(true);
    expect(canManageWithdrawals('ADMIN')).toBe(true);
  });

  it('renders flash feedback', () => {
    const element = Flash({ message: 'stale withdrawal', type: 'error' });
    expect(element?.props.children).toEqual([labels.error, ': ', 'stale withdrawal']);
  });

  it('rejects a Google callback when the CSRF tokens differ', async () => {
    const { POST } = await import('./app/api/google-login/route');
    const body = new URLSearchParams({ credential: 'google-token', g_csrf_token: 'different-token' });
    const response = await POST(new Request('http://localhost/api/google-login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost/login?error=Invalid+username+or+password.');
  });
});
