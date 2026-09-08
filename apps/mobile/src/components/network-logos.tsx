import React from 'react';
import Svg, { Circle, Path } from 'react-native-svg';

export function TetherLogo({ size = 28 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 28 28" accessibilityLabel="Tether">
      <Circle cx="14" cy="14" r="14" fill="#26A17B" />
      <Path
        d="M8 7h12v3h-4.5v9h-3v-9H8V7Zm-1 4h14v1H7v-1Z"
        fill="#fff"
      />
    </Svg>
  );
}

export function PolygonLogo({ size = 28 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 28 28" accessibilityLabel="Polygon">
      <Circle cx="14" cy="14" r="14" fill="#8247E5" />
      <Path
        d="m9 5 5 2.9v5.8L9 16.6 4 13.7V7.9L9 5Zm0 3.1L6.7 9.4v2.8L9 13.5l2.3-1.3V9.4L9 8.1Zm10 3.8-5 2.9v5.8l5 2.9 5-2.9v-5.8l-5-2.9Zm0 3.1-2.3 1.3v2.8l2.3 1.3 2.3-1.3v-2.8L19 15Zm-5 1.9-2.3-1.3v-2.8l2.3-1.3 2.3 1.3v2.8L14 16.9Z"
        fill="#fff"
        fillRule="evenodd"
      />
    </Svg>
  );
}
