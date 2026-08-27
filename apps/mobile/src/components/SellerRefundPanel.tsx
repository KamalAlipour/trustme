import React from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import * as FileSystem from 'expo-file-system';
import { API_BASE_URL, getAccessToken, request } from '../api/client';
import { useInvalidateMoney, useRefunds } from '../hooks';
import { useSession } from '../auth/session';
import { formatCoupons, formatDate } from '../lib/format';
import { mapApiError } from '../lib/errors';
import { fa } from '../i18n/fa';
import { styles } from '../styles';

async function downloadEvidence(id: string): Promise<void> {
  const directory = FileSystem.cacheDirectory;
  const token = getAccessToken();
  if (directory === null || token === null) return;
  await FileSystem.downloadAsync(`${API_BASE_URL}/v1/me/media/${encodeURIComponent(id)}`, `${directory}refund-evidence-${id}`, { headers: { authorization: `Bearer ${token}` } });
}

export function SellerRefundPanel() {
  const refunds = useRefunds('seller');
  const invalidate = useInvalidateMoney();
  const { getStepUpPin } = useSession();
  const [collapsed, setCollapsed] = React.useState<string[]>([]);
  const [notes, setNotes] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState('');
  const rows = refunds.data?.pages.flatMap((page) => page.items) ?? [];
  const decide = async (id: string, action: 'approve' | 'reject') => {
    setError('');
    try {
      if (action === 'approve') {
        const pin = await getStepUpPin();
        if (!pin) { setError('رمز برای این عملیات لازم است.'); return; }
        await request(`/v1/me/refunds/${id}/approve`, { method: 'POST', body: { pin } });
      } else {
        const note = notes[id]?.trim();
        if (!note) { setError(fa.rejectionNote); return; }
        await request(`/v1/me/refunds/${id}/reject`, { method: 'POST', body: { note } });
      }
      await invalidate();
    } catch (cause) { setError(mapApiError(cause)); }
  };
  return <View style={styles.card}>
    <Text style={styles.heading}>{fa.refunds}</Text>
    {refunds.isLoading ? <Text style={styles.muted}>در حال بارگذاری…</Text> : null}
    {rows.filter((row) => row.status === 'PENDING' && !collapsed.includes(row.id)).map((row) => <View key={row.id} style={styles.card}>
      <Text style={styles.text}>{row.counterparty.displayName ?? row.counterparty.barcodeId} · {formatCoupons(row.amountCoupons)} کوپن</Text>
      <Text style={styles.muted}>{row.reason}</Text>
      <Text style={styles.muted}>خرید: {formatDate(row.originalTransactionDate)}</Text>
      <View style={styles.row}>{row.mediaIds.map((id) => <Pressable key={id} onPress={() => void downloadEvidence(id)}><Text style={styles.secondaryButtonText}>📎 {id.slice(0, 8)}</Text></Pressable>)}</View>
      <Text style={styles.muted}>🟡 {fa.refundPending}</Text>
      <TextInput value={notes[row.id] ?? ''} onChangeText={(value) => setNotes((current) => ({ ...current, [row.id]: value }))} placeholder={fa.rejectionNote} style={styles.input} />
      <View style={styles.row}><Pressable onPress={() => void decide(row.id, 'approve')} style={styles.button}><Text style={styles.buttonText}>{fa.approve}</Text></Pressable><Pressable onPress={() => void decide(row.id, 'reject')} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{fa.reject}</Text></Pressable><Pressable onPress={() => setCollapsed((current) => [...current, row.id])}><Text style={styles.muted}>{fa.reviewLater}</Text></Pressable></View>
    </View>)}
    {refunds.hasNextPage ? <Pressable onPress={() => void refunds.fetchNextPage()} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>موارد بیشتر</Text></Pressable> : null}
    {error ? <Text style={styles.danger}>{error}</Text> : null}
  </View>;
}
