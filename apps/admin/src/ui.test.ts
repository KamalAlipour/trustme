import { describe, expect, it } from 'vitest';
import { availabilityLabel } from './components/overview';
import { canRejectWithdrawal } from './components/withdrawal-rules';
import { Flash } from './components/flash';
import { labels } from './labels';
import { canManageWithdrawals } from './lib/session';
import { truncateAddress } from './lib/format';

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
});
