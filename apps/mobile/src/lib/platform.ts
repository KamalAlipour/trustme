import { Platform } from 'react-native';

export function isWebPlatform(): boolean {
  return Platform.OS === 'web';
}

export function getRtlDirectionProps(): { dir: 'rtl' } | Record<string, never> {
  return isWebPlatform() ? { dir: 'rtl' } : {};
}
