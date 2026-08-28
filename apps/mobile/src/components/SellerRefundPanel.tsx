import React from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { request } from '../api/client';
import { useInvalidateMoney, useRefunds } from '../hooks';
import { useSession } from '../auth/session';
import { formatCoupons, formatDate } from '../lib/format';
import { mapApiError } from '../lib/errors';
import { useTranslation } from '../i18n';
import { styles } from '../styles';
import { EvidenceViewer } from './EvidenceViewer';

export function SellerRefundPanel() {
  const { t, language } = useTranslation();
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
        if (!pin) { setError(t.operationPinRequired); return; }
        await request(`/v1/me/refunds/${id}/approve`, { method: 'POST', body: { pin } });
      } else {
        const note = notes[id]?.trim();
        if (!note) { setError(t.rejectionNote); return; }
        await request(`/v1/me/refunds/${id}/reject`, { method: 'POST', body: { note } });
      }
      await invalidate();
    } catch (cause) { setError(mapApiError(cause, t)); }
  };
  return <View style={styles.card}>
    <Text style={styles.heading}>{t.refunds}</Text>
    {refunds.isLoading ? <Text style={styles.muted}>{t.loading}</Text> : null}
    {rows.filter((row) => row.status === 'PENDING' && !collapsed.includes(row.id)).map((row) => <View key={row.id} style={styles.card}>
      <Text style={styles.text}>{row.counterparty.displayName ?? row.counterparty.barcodeId} · {t.couponBalance(formatCoupons(row.amountCoupons, language))}</Text>
      <Text style={styles.muted}>{row.reason}</Text>
      <Text style={styles.muted}>{t.purchases}: {formatDate(row.originalTransactionDate, language)}</Text>
      <EvidenceViewer ids={row.mediaIds} />
      <Text style={styles.muted}>🟡 {t.refundPending}</Text>
      <TextInput value={notes[row.id] ?? ''} onChangeText={(value) => setNotes((current) => ({ ...current, [row.id]: value }))} placeholder={t.rejectionNote} style={styles.input} />
      <View style={styles.row}><Pressable onPress={() => void decide(row.id, 'approve')} style={styles.button}><Text style={styles.buttonText}>{t.approve}</Text></Pressable><Pressable onPress={() => void decide(row.id, 'reject')} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.reject}</Text></Pressable><Pressable onPress={() => setCollapsed((current) => [...current, row.id])}><Text style={styles.muted}>{t.reviewLater}</Text></Pressable></View>
    </View>)}
    {refunds.hasNextPage ? <Pressable onPress={() => void refunds.fetchNextPage()} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.moreItems}</Text></Pressable> : null}
    {error ? <Text style={styles.danger}>{error}</Text> : null}
  </View>;
}
