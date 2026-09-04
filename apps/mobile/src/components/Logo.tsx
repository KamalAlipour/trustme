import React from 'react';
import { Image } from 'react-native';

export function Logo({ size = 32 }: { size?: number }) {
  return (
    <Image
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      source={require('../../assets/icon.png')}
      style={{ width: size, height: size, borderRadius: size * 0.22 }}
      accessibilityIgnoresInvertColors
      accessible={false}
    />
  );
}
