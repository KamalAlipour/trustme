import { describe, expect, it } from 'vitest';
import { formatMicroUsdt } from './format';

describe('micro-USDT formatting', () => {
  it('formats quote amounts without changing their exact precision', () => {
    expect(formatMicroUsdt('200000')).toBe('0.2');
    expect(formatMicroUsdt('1800000')).toBe('1.8');
  });
});
