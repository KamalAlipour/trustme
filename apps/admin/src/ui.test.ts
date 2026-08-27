import { describe, expect, it } from 'vitest';
import { availabilityLabel } from './components/overview';
import { canRejectWithdrawal } from './components/withdrawal-rules';
import { labels } from './labels';

describe('admin UI rules', () => {
  it('labels unavailable chain data explicitly', () => {
    expect(availabilityLabel(false)).toBe(labels.unavailable);
  });

  it('does not offer rejection for chain-hashed withdrawals', () => {
    expect(canRejectWithdrawal({ status: 'PROCESSING', chainTxHash: '0xhash' })).toBe(false);
    expect(canRejectWithdrawal({ status: 'PENDING_APPROVAL', chainTxHash: null })).toBe(true);
  });
});
