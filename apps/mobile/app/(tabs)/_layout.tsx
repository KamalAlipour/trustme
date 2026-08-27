import React from 'react';
import { Redirect, Tabs } from 'expo-router';
import { useSession } from '../../src/auth/session';
import { fa } from '../../src/i18n/fa';

export default function TabsLayout() {
  const { ready, member } = useSession();
  if (!ready) return null;
  if (member === null) return <Redirect href="/(auth)/login" />;
  return (
    <Tabs screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="index" options={{ title: fa.home }} />
      <Tabs.Screen name="purchases" options={{ title: fa.purchases }} />
      <Tabs.Screen name="lending" options={{ title: fa.lending }} />
      <Tabs.Screen name="profile" options={{ title: fa.profile }} />
    </Tabs>
  );
}
