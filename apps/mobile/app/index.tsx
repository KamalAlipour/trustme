import React from 'react';
import { Redirect } from 'expo-router';
import { LoadingScreen } from '../src/components/Screen';
import { useSession } from '../src/auth/session';

export default function Index() {
  const { ready, member } = useSession();
  if (!ready) return <LoadingScreen />;
  return <Redirect href={member === null ? '/(auth)/login' : '/(tabs)'} />;
}
