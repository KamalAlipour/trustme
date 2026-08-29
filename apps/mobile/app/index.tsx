import React from 'react';
import { Redirect } from 'expo-router';
import { LoadingScreen } from '../src/components/Screen';
import { useSession } from '../src/auth/session';
import { getSetupRoute } from '../src/auth/setup-routing';
import { UnlockScreen } from '../src/auth/UnlockScreen';

export default function Index() {
  const { ready, member, setup, unlockRequired } = useSession();
  if (!ready) return <LoadingScreen />;
  if (unlockRequired) return <UnlockScreen />;
  if (member === null) return <Redirect href="/(auth)/login" />;
  if (setup === null) return <LoadingScreen />;
  const route = getSetupRoute(setup);
  if (route === 'verify-email') return <Redirect href={{ pathname: '/(auth)/verify-email', params: { email: member.email ?? '' } }} />;
  if (route === 'security-setup') return <Redirect href="/(auth)/security-setup" />;
  return <Redirect href="/(tabs)" />;
}
