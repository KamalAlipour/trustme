import React, { useEffect, useRef } from 'react';
import { Redirect, Tabs, router } from 'expo-router';
import { useSession } from '../../src/auth/session';
import { useTranslation } from '../../src/i18n';
import { hasSeenManifesto } from '../../src/lib/storage';
import { shouldShowManifesto } from '../../src/lib/manifesto';

export default function TabsLayout() {
  const { t } = useTranslation();
  const { ready, member } = useSession();
  const checkedManifesto = useRef(false);
  useEffect(() => {
    if (!ready || member === null || checkedManifesto.current) return;
    checkedManifesto.current = true;
    void hasSeenManifesto().then((seen) => {
      if (shouldShowManifesto(seen)) router.push('/about');
    });
  }, [member, ready]);
  if (!ready) return null;
  if (member === null) return <Redirect href="/(auth)/login" />;
  return (
    <Tabs screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="index" options={{ title: t.home }} />
      <Tabs.Screen name="purchases" options={{ title: t.purchases }} />
      <Tabs.Screen name="lending" options={{ title: t.lending }} />
      <Tabs.Screen name="profile" options={{ title: t.profile }} />
    </Tabs>
  );
}
