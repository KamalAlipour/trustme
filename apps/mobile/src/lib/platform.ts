import { Platform } from 'react-native';

export function isWebPlatform(): boolean {
  return Platform.OS === 'web';
}
