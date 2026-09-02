import { describe, expect, it } from 'vitest';
import { availableEscrowMicroUsdt, escrowReference } from '../src/escrow-payments.js';

describe('prepaid escrow payments', () => {
  it('calculates available balance without going negative', () => {
    expect(availableEscrowMicroUsdt({ lockedMicroUsdt: 12n, reservedMicroUsdt: 5n })).toBe(7n);
    expect(availableEscrowMicroUsdt({ lockedMicroUsdt: 5n, reservedMicroUsdt: 8n })).toBe(0n);
  });

  it('uses distinct deterministic settlement and unload references', () => {
    expect(escrowReference('settlement', 'abc')).toMatch(/^0x[0-9a-f]{64}$/);
    expect(escrowReference('settlement', 'abc')).not.toBe(escrowReference('unload', 'abc'));
  });
});
