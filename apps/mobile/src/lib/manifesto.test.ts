import { describe, expect, it } from 'vitest';
import { shouldShowManifesto } from './manifesto';

describe('manifesto visibility', () => {
  it('shows when the non-sensitive seen flag is unset', () => {
    expect(shouldShowManifesto(false)).toBe(true);
  });
  it('does not show after dismissal has been persisted', () => {
    expect(shouldShowManifesto(true)).toBe(false);
  });
});
