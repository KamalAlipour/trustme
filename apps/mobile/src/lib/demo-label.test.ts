import { describe, expect, it } from 'vitest';
import { shouldShowDemoLabel } from './demo-label';

describe('demo label', () => {
  it('shows only for demo records', () => {
    expect(shouldShowDemoLabel(true)).toBe(true);
    expect(shouldShowDemoLabel(false)).toBe(false);
  });
});
