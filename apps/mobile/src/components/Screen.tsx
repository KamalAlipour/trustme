import React from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { colors, styles } from '../styles';
import { useTranslation } from '../i18n';

export function LoadingScreen() {
  const { t, direction } = useTranslation();
  return <View style={[styles.centered, { direction }]}><ActivityIndicator color={colors.primary} /><Text style={styles.muted}>{t.loading}</Text></View>;
}

export function ErrorMessage({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t, direction } = useTranslation();
  return <View style={[styles.card, { direction }]}><Text style={styles.danger}>{message}</Text>{onRetry ? <Text onPress={onRetry} style={styles.secondaryButtonText}>{t.retry}</Text> : null}</View>;
}

export function Page({ children }: { children: React.ReactNode }) {
  const { direction } = useTranslation();
  return <ScrollView contentContainerStyle={[styles.scroll, { direction }]} keyboardShouldPersistTaps="handled">{children}</ScrollView>;
}
