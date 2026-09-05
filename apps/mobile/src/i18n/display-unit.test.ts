import { describe, expect, it } from 'vitest';
import { en } from './en';
import { fa } from './fa';
import { DEFAULT_DISPLAY_UNIT } from './display-unit';

describe('display unit translations', () => {
  it('uses the default English and Persian display unit names', () => {
    expect(en(DEFAULT_DISPLAY_UNIT).couponBalance('12')).toContain('US cent');
    expect(fa(DEFAULT_DISPLAY_UNIT).couponBalance('۱۲')).toContain('سنت دلار آمریکا');
  });
});
