import React, { useEffect, useRef } from 'react';
import { Redirect, Tabs, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSession } from '../../src/auth/session';
import { useTranslation } from '../../src/i18n';
import { hasSeenManifesto } from '../../src/lib/storage';
import { shouldShowManifesto } from '../../src/lib/manifesto';
import { UnlockScreen } from '../../src/auth/UnlockScreen';
import { colors } from '../../src/styles';

export default function TabsLayout() {
  const { t } = useTranslation();
  const { ready, member, unlockRequired } = useSession();
  const checkedManifesto = useRef(false);
  useEffect(() => {
    if (!ready || member === null || checkedManifesto.current) return;
    checkedManifesto.current = true;
    void hasSeenManifesto().then((seen) => {
      if (shouldShowManifesto(seen)) router.push('/about');
    });
  }, [member, ready]);
  if (!ready) return null;
  if (unlockRequired) return <UnlockScreen />;
  if (member === null) return <Redirect href="/(auth)/login" />;
  return (
    <Tabs screenOptions={{
      headerShown: false,
      tabBarActiveTintColor: colors.primary,
      tabBarInactiveTintColor: colors.muted,
      tabBarLabelStyle: { fontSize: 16, fontWeight: '700' },
      tabBarStyle: {
        height: 82,
        paddingTop: 8,
        paddingBottom: 12,
        borderTopWidth: 1,
        borderTopColor: colors.border,
        backgroundColor: colors.card,
      },
    }}>
      <Tabs.Screen name="index" options={{
        title: t.home,
        tabBarLabel: t.tabHome,
        tabBarIcon: ({ color, size }) => <Ionicons name="home-outline" color={color} size={size} />,
      }} />
      <Tabs.Screen name="purchases" options={{
        title: t.purchases,
        tabBarLabel: t.tabPurchases,
        tabBarIcon: ({ color, size }) => <Ionicons name="receipt-outline" color={color} size={size} />,
      }} />
      <Tabs.Screen name="lending" options={{
        title: t.lending,
        tabBarLabel: t.tabLending,
        tabBarIcon: ({ color, size }) => <Ionicons name="cash-outline" color={color} size={size} />,
      }} />
      <Tabs.Screen name="profile" options={{
        title: t.profile,
        tabBarLabel: t.tabProfile,
        tabBarIcon: ({ color, size }) => <Ionicons name="person-outline" color={color} size={size} />,
      }} />
    </Tabs>
  );
}
