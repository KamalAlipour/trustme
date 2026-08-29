import React, { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, Share, Text, TextInput, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { ApiError, request } from '../../src/api/client';
import { useSession } from '../../src/auth/session';
import { Page, LoadingScreen } from '../../src/components/Screen';
import { useBalance, useDisclosures, useInvalidateMoney, useMember } from '../../src/hooks';
import { useTranslation } from '../../src/i18n';
import { randomFourDigitCode } from '../../src/lib/code';
import { formatCoupons } from '../../src/lib/format';
import { colors, styles } from '../../src/styles';

function formatDisclosureCountdown(expiresAt: string, now: number): string {
  const remainingSeconds = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1000));
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = (remainingSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export default function Home() {
  const { t, language } = useTranslation();
  const { member, getStepUpPin } = useSession();
  const profile = useMember();
  const balance = useBalance();
  const disclosures = useDisclosures();
  const invalidate = useInvalidateMoney();
  const params = useLocalSearchParams<{ barcodeId?: string }>();
  const [amount, setAmount] = useState('');
  const [barcodeId, setBarcodeId] = useState(params.barcodeId ?? '');
  const [pin, setPin] = useState('');
  const [merchant, setMerchant] = useState(false);
  const [escrowCode, setEscrowCode] = useState('');
  const [error, setError] = useState('');
  const [barcodeShareError, setBarcodeShareError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (params.barcodeId !== undefined) setBarcodeId(params.barcodeId);
  }, [params.barcodeId]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (balance.isLoading) return <LoadingScreen />;
  const submitTransfer = async () => {
    setError('');
    try {
      const stepUp = pin || await getStepUpPin();
      if (!stepUp) { setError(t.operationPinRequired); return; }
      await request('/v1/me/transfers', { method: 'POST', body: { toBarcodeId: barcodeId, amountCoupons: amount, idempotencyKey: `mobile-${Date.now()}`, pin: stepUp } });
      setAmount(''); setPin(''); await invalidate();
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : t.unknownError); }
  };
  const submitEscrow = async () => {
    setError('');
    try {
      const code = await randomFourDigitCode();
      const stepUp = pin || await getStepUpPin();
      if (!stepUp) { setError(t.operationPinRequired); return; }
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
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : t.unknownError); }
  };
  const ownBarcodeId = balance.data?.barcodeId ?? member?.barcodeId ?? profile.data?.barcodeId;
  const shareBarcode = async () => {
    if (!ownBarcodeId) return;
    setBarcodeShareError('');
    try {
      await Share.share({ message: ownBarcodeId });
    } catch {
      setBarcodeShareError(t.barcodeShareUnavailable);
    }
  };
  return (
    <Page>
      <View style={styles.row}><Text style={styles.title}>{t.home}</Text><Pressable onPress={() => router.push('/contacts')}><Text style={styles.secondaryButtonText}>{t.contacts}</Text></Pressable></View>
      {disclosures.data?.items.map((disclosure) => (
        <View key={disclosure.id} style={styles.card}>
          <Text style={styles.heading}>{t.balanceDisclosureTitle}</Text>
          <Text style={styles.text}>{t.balanceDisclosureMessage}</Text>
          <Text style={styles.muted}>{t.balanceDisclosureCode}</Text>
          <Text style={{ ...styles.title, textAlign: 'center', letterSpacing: 8 }}>{disclosure.code}</Text>
          <Text style={styles.muted}>{t.balanceDisclosureExpires(formatDisclosureCountdown(disclosure.expiresAt, now))}</Text>
          <Pressable onPress={async () => { setError(''); try { await request(`/v1/me/disclosures/${disclosure.id}/deny`, { method: 'POST' }); await invalidate(); } catch (cause) { setError(cause instanceof ApiError ? cause.message : t.unknownError); } }} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.denyDisclosure}</Text></Pressable>
        </View>
      ))}
      <Pressable onPress={() => router.push('/barcodes')} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.barcodeSearch}</Text></Pressable>
      <View style={styles.card}>
        <Text style={styles.muted}>{t.balance}</Text>
        <Text style={{ ...styles.title, fontSize: 34 }}>{formatCoupons(balance.data?.coupons ?? '0', language)}</Text>
        <Text style={styles.muted}>{member?.displayName ?? profile.data?.displayName ?? ''}</Text>
      </View>
      {member?.isRestricted ? <View style={styles.card}><Text style={styles.danger}>{t.restricted}</Text><Text style={styles.text}>{t.restrictedExplanation}</Text></View> : null}
      {ownBarcodeId ? <View style={styles.card}>
        <Text style={styles.heading}>{t.myBarcode}</Text>
        <Text style={styles.muted}>{t.myBarcodeInstructions}</Text>
        <View style={styles.barcodeQr}>
          <QRCode value={ownBarcodeId} size={220} color={colors.ink} backgroundColor={colors.card} />
          <Text selectable style={{ ...styles.title, textAlign: 'center', letterSpacing: 2 }}>{ownBarcodeId}</Text>
        </View>
        <Pressable onPress={() => void shareBarcode()} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>{t.shareBarcode}</Text>
        </Pressable>
        {barcodeShareError ? <Text style={styles.danger}>{barcodeShareError}</Text> : null}
      </View> : null}
      <View style={styles.card}>
        <Text style={styles.heading}>{merchant ? t.payMerchant : t.send}</Text>
        <TextInput value={barcodeId} onChangeText={setBarcodeId} placeholder={t.barcode} style={styles.input} />
        <TextInput value={amount} onChangeText={(value) => setAmount(value.replace(/\D/g, ''))} placeholder={t.amount} style={styles.input} keyboardType="number-pad" />
        <TextInput value={pin} onChangeText={(value) => setPin(value.replace(/\D/g, '').slice(0, 4))} placeholder={t.pin} style={styles.input} keyboardType="number-pad" secureTextEntry />
        <Pressable onPress={() => void (merchant ? submitEscrow() : submitTransfer())} style={styles.button}><Text style={styles.buttonText}>{merchant ? t.payMerchant : t.send}</Text></Pressable>
        <Pressable onPress={() => router.push({ pathname: '/scan', params: { returnTo: '/(tabs)' } })} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.scanQr}</Text></Pressable>
        <Pressable onPress={() => setMerchant(!merchant)}><Text style={styles.secondaryButtonText}>{merchant ? t.send : t.payMerchant}</Text></Pressable>
        {escrowCode ? <View style={{ backgroundColor: '#FFFFFF', padding: 20, alignItems: 'center' }}><Text style={styles.muted}>{t.paymentCreatedCode}</Text><Text style={{ ...styles.title, textAlign: 'center', letterSpacing: 8 }}>{escrowCode}</Text></View> : null}
        {error ? <Text style={styles.danger}>{error}</Text> : null}
      </View>
    </Page>
  );
}
