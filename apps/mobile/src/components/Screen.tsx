import React from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { colors, styles } from '../styles';

export function LoadingScreen() {
  return <View style={styles.centered}><ActivityIndicator color={colors.primary} /><Text style={styles.muted}>در حال بارگذاری…</Text></View>;
}

export function ErrorMessage({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <View style={styles.card}><Text style={styles.danger}>{message}</Text>{onRetry ? <Text onPress={onRetry} style={styles.secondaryButtonText}>تلاش دوباره</Text> : null}</View>;
}

export function Page({ children }: { children: React.ReactNode }) {
  return <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">{children}</ScrollView>;
}
