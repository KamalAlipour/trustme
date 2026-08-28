import React from 'react';
import { Modal, Pressable, Text, TextInput, View } from 'react-native';
import { request } from '../api/client';
import { EvidencePicker } from './EvidencePicker';
import { useInvalidateMoney } from '../hooks';
import { mapApiError } from '../lib/errors';
import { useTranslation } from '../i18n';
import { styles } from '../styles';

export function RefundSheet({ transactionId, purchaseAmount, onClose }: { transactionId: string; purchaseAmount: string; onClose: () => void }) {
  const { t, direction } = useTranslation();
  const [amount, setAmount] = React.useState(purchaseAmount);
  const [reason, setReason] = React.useState('');
  const [mediaIds, setMediaIds] = React.useState<string[]>([]);
  const [error, setError] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const invalidate = useInvalidateMoney();

  const submit = async () => {
    setError('');
    if (reason.trim().length === 0) { setError(t.reasonRequired); return; }
    try {
      const requested = BigInt(amount || '0');
      const maximum = BigInt(purchaseAmount);
      if (requested <= 0n || requested > maximum) { setError(t.amountTooHigh); return; }
    } catch { setError(t.amountTooHigh); return; }
    setSubmitting(true);
    try {
      await request('/v1/me/refunds', { method: 'POST', body: { transactionId, amountCoupons: amount, reason: reason.trim(), mediaIds } });
      await invalidate();
      onClose();
    } catch (cause) {
      setError(mapApiError(cause, t));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, padding: 20, gap: 14, backgroundColor: '#F5F8FA', direction }}>
        <Text style={styles.title}>{t.requestRefund}</Text>
        <TextInput value={amount} onChangeText={(value) => setAmount(value.replace(/\D/g, ''))} placeholder={t.amount} style={styles.input} keyboardType="number-pad" />
        <TextInput value={reason} onChangeText={setReason} placeholder={t.reasonRequired} style={styles.input} multiline />
        <EvidencePicker mediaIds={mediaIds} onChange={setMediaIds} />
        {error ? <Text style={styles.danger}>{error}</Text> : null}
        <Pressable disabled={submitting} onPress={() => void submit()} style={styles.button}><Text style={styles.buttonText}>{submitting ? t.uploading : t.submitRefund}</Text></Pressable>
        <Pressable onPress={onClose} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.cancel}</Text></Pressable>
      </View>
    </Modal>
  );
}
