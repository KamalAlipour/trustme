import { describe, expect, it } from 'vitest';
import { ISO_ALPHA2_COUNTRIES as coreCountries } from '../../../../packages/core/src/countries.js';
import { ISO_ALPHA2_COUNTRIES as mobileCountries } from './countries';

describe('mobile country registry', () => {
  it('matches the core country registry', () => {
    expect(mobileCountries).toEqual(coreCountries);
  });
});
