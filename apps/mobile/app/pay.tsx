import React from 'react';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useSession } from '../src/auth/session';
import { LoadingScreen } from '../src/components/Screen';

export default function PayLink() {
  const { ready, member } = useSession();
  const { barcodeId } = useLocalSearchParams<{ barcodeId?: string }>();
  if (!ready) return <LoadingScreen />;
  if (member === null) return <Redirect href="/(auth)/login" />;
  return <Redirect href={{ pathname: '/(tabs)', params: { barcodeId: Array.isArray(barcodeId) ? barcodeId[0] ?? '' : barcodeId ?? '', field: 'pay' } }} />;
}
