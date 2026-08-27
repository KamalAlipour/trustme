import React, { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, Text, TextInput, View } from 'react-native';
import { ApiError, request } from '../../src/api/client';
import { useSession } from '../../src/auth/session';
import { Page, LoadingScreen } from '../../src/components/Screen';
import { useBalance, useInvalidateMoney, useMember } from '../../src/hooks';
import { fa } from '../../src/i18n/fa';
import { randomFourDigitCode } from '../../src/lib/code';
import { formatCoupons } from '../../src/lib/format';
import { styles } from '../../src/styles';

export default function Home() {
  const { member, getStepUpPin } = useSession();
  const profile = useMember();
  const balance = useBalance();
  const invalidate = useInvalidateMoney();
  const params = useLocalSearchParams<{ barcodeId?: string }>();
  const [amount, setAmount] = useState('');
  const [barcodeId, setBarcodeId] = useState(params.barcodeId ?? '');
  const [pin, setPin] = useState('');
  const [merchant, setMerchant] = useState(false);
  const [escrowCode, setEscrowCode] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (params.barcodeId !== undefined) setBarcodeId(params.barcodeId);
  }, [params.barcodeId]);
  if (balance.isLoading) return <LoadingScreen />;
  const submitTransfer = async () => {
    setError('');
    try {
      const stepUp = pin || await getStepUpPin();
      if (!stepUp) { setError('رمز برای این عملیات لازم است.'); return; }
      await request('/v1/me/transfers', { method: 'POST', body: { toBarcodeId: barcodeId, amountCoupons: amount, idempotencyKey: `mobile-${Date.now()}`, pin: stepUp } });
      setAmount(''); setPin(''); await invalidate();
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : fa.unknownError); }
  };
  const submitEscrow = async () => {
    setError('');
    try {
      const code = await randomFourDigitCode();
      const stepUp = pin || await getStepUpPin();
      if (!stepUp) { setError('رمز برای این عملیات لازم است.'); return; }
      await request('/v1/me/escrows', { method: 'POST', body: {
        recipientBarcodeId: barcodeId,
        amountCoupons: amount,
        code,
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        idempotencyKey: `mobile-escrow-${Date.now()}`,
        pin: stepUp,
      } });
      setEscrowCode(code);
      setPin('');
      await invalidate();
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : fa.unknownError); }
  };
  return (
    <Page>
      <View style={styles.row}><Text style={styles.title}>{fa.home}</Text><Pressable onPress={() => router.push('/contacts')}><Text style={styles.secondaryButtonText}>{fa.contacts}</Text></Pressable></View>
      <View style={styles.card}>
        <Text style={styles.muted}>{fa.balance}</Text>
        <Text style={{ ...styles.title, fontSize: 34 }}>{formatCoupons(balance.data?.coupons ?? '0')}</Text>
        <Text style={styles.muted}>{member?.displayName ?? profile.data?.displayName ?? ''}</Text>
      </View>
      {member?.isRestricted ? <View style={styles.card}><Text style={styles.danger}>{fa.restricted}</Text><Text style={styles.text}>{fa.restrictedExplanation}</Text></View> : null}
      <View style={styles.card}>
        <Text style={styles.heading}>{merchant ? fa.payMerchant : fa.send}</Text>
        <TextInput value={barcodeId} onChangeText={setBarcodeId} placeholder={fa.barcode} style={styles.input} />
        <TextInput value={amount} onChangeText={(value) => setAmount(value.replace(/\D/g, ''))} placeholder={fa.amount} style={styles.input} keyboardType="number-pad" />
        <TextInput value={pin} onChangeText={(value) => setPin(value.replace(/\D/g, '').slice(0, 4))} placeholder={fa.pin} style={styles.input} keyboardType="number-pad" secureTextEntry />
        <Pressable onPress={() => void (merchant ? submitEscrow() : submitTransfer())} style={styles.button}><Text style={styles.buttonText}>{merchant ? 'ساخت پرداخت' : fa.send}</Text></Pressable>
        <Pressable onPress={() => router.push({ pathname: '/scan', params: { returnTo: '/(tabs)' } })} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>اسکن QR</Text></Pressable>
        <Pressable onPress={() => setMerchant(!merchant)}><Text style={styles.secondaryButtonText}>{merchant ? fa.send : fa.payMerchant}</Text></Pressable>
        {escrowCode ? <View style={{ backgroundColor: '#FFFFFF', padding: 20, alignItems: 'center' }}><Text style={styles.muted}>این کد را برای پذیرنده بخوانید:</Text><Text style={{ ...styles.title, textAlign: 'center', letterSpacing: 8 }}>{escrowCode}</Text></View> : null}
        {error ? <Text style={styles.danger}>{error}</Text> : null}
      </View>
    </Page>
  );
}
