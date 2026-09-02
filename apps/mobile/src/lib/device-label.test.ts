import { describe, expect, it } from 'vitest';
import { deviceLabelFrom } from './device-label';

describe('device labels', () => {
  it('uses a browser fallback when the web user agent is missing', () => {
    expect(deviceLabelFrom('web', null, null)).toBe('Browser');
    expect(deviceLabelFrom('web', null, '')).toBe('Browser');
  });

  it('recognises Samsung Internet before nested Chrome and Safari matches', () => {
    expect(deviceLabelFrom('web', null, 'Mozilla SamsungBrowser Chrome Safari Android')).toBe('Samsung Internet on Android');
  });

  it('recognises Edge before its nested Chrome match', () => {
    expect(deviceLabelFrom('web', null, 'Mozilla Edg Chrome Windows')).toBe('Edge on Windows');
  });

  it('recognises Opera from both user-agent markers', () => {
    expect(deviceLabelFrom('web', null, 'Mozilla OPR Chrome Mac OS')).toBe('Opera on Mac');
    expect(deviceLabelFrom('web', null, 'Mozilla Opera Linux')).toBe('Opera on Linux');
  });

  it('recognises Firefox', () => {
    expect(deviceLabelFrom('web', null, 'Mozilla Firefox Linux')).toBe('Firefox on Linux');
  });

  it('recognises Chrome and CriOS', () => {
    expect(deviceLabelFrom('web', null, 'Mozilla Chrome Windows')).toBe('Chrome on Windows');
    expect(deviceLabelFrom('web', null, 'Mozilla CriOS iPhone')).toBe('Chrome on iPhone');
  });

  it('recognises Safari and all supported operating systems', () => {
    expect(deviceLabelFrom('web', null, 'Mozilla Safari iPad')).toBe('Safari on iPad');
    expect(deviceLabelFrom('web', null, 'Mozilla Safari Mac OS')).toBe('Safari on Mac');
    expect(deviceLabelFrom('web', null, 'Mozilla Safari Android')).toBe('Safari on Android');
  });

  it('falls back to the browser name when the operating system is unknown', () => {
    expect(deviceLabelFrom('web', null, 'Mozilla Chrome BeOS')).toBe('Chrome');
    expect(deviceLabelFrom('web', null, 'Mozilla BeOS')).toBe('Browser');
  });

  it('formats native iOS and Android labels with versions', () => {
    expect(deviceLabelFrom('ios', 18, null)).toBe('iOS 18 app');
    expect(deviceLabelFrom('android', '14', null)).toBe('Android 14 app');
  });

  it('formats native labels without versions and never returns an empty string', () => {
    expect(deviceLabelFrom('ios', null, null)).toBe('iOS app');
    expect(deviceLabelFrom('android', '', null)).toBe('Android app');
    expect(deviceLabelFrom('Windows', null, null)).toBe('Windows app');
    expect(deviceLabelFrom('', null, null)).toBe('Unknown app');
  });
});
