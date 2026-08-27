import React from 'react';
import { Modal, Pressable, Text, TextInput, View } from 'react-native';
import { request } from '../api/client';
import { EvidencePicker } from './EvidencePicker';
import { useInvalidateMoney } from '../hooks';
import { mapApiError } from '../lib/errors';
import { fa } from '../i18n/fa';
import { styles } from '../styles';

export function RefundSheet({ transactionId, purchaseAmount, onClose }: { transactionId: string; purchaseAmount: string; onClose: () => void }) {
  const [amount, setAmount] = React.useState(purchaseAmount);
  const [reason, setReason] = React.useState('');
  const [mediaIds, setMediaIds] = React.useState<string[]>([]);
  const [error, setError] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const invalidate = useInvalidateMoney();

  const submit = async () => {
    setError('');
    if (reason.trim().length === 0) { setError(fa.reasonRequired); return; }
    try {
      const requested = BigInt(amount || '0');
      const maximum = BigInt(purchaseAmount);
      if (requested <= 0n || requested > maximum) { setError(fa.amountTooHigh); return; }
    } catch { setError(fa.amountTooHigh); return; }
    setSubmitting(true);
    try {
      await request('/v1/me/refunds', { method: 'POST', body: { transactionId, amountCoupons: amount, reason: reason.trim(), mediaIds } });
      await invalidate();
      onClose();
    } catch (cause) {
      setError(mapApiError(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, padding: 20, gap: 14, backgroundColor: '#F5F8FA' }}>
        <Text style={styles.title}>{fa.requestRefund}</Text>
        <TextInput value={amount} onChangeText={(value) => setAmount(value.replace(/\D/g, ''))} placeholder={fa.amount} style={styles.input} keyboardType="number-pad" />
        <TextInput value={reason} onChangeText={setReason} placeholder={fa.reasonRequired} style={styles.input} multiline />
        <EvidencePicker mediaIds={mediaIds} onChange={setMediaIds} />
        {error ? <Text style={styles.danger}>{error}</Text> : null}
        <Pressable disabled={submitting} onPress={() => void submit()} style={styles.button}><Text style={styles.buttonText}>{submitting ? 'در حال ارسال…' : fa.submitRefund}</Text></Pressable>
        <Pressable onPress={onClose} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{fa.cancel}</Text></Pressable>
      </View>
    </Modal>
  );
}
