import React, { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Pressable, Share, Text, TextInput, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { ApiError, request } from '../../src/api/client';
import { useSession } from '../../src/auth/session';
import { Page, LoadingScreen } from '../../src/components/Screen';
import { useBalance, useDisclosures, useEscrowBalance, useEscrowConfig, useInvalidateMoney, useMember } from '../../src/hooks';
import { useTranslation } from '../../src/i18n';
import { randomFourDigitCode } from '../../src/lib/code';
import { formatEscrowCountdown, parseUsdtAmount } from '../../src/lib/escrow';
import { mapApiError } from '../../src/lib/errors';
import { formatCoupons, formatMicroUsdt } from '../../src/lib/format';
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
  const escrowConfig = useEscrowConfig();
  const escrowEnabled = escrowConfig.data?.enabled === true;
  const escrowBalance = useEscrowBalance(escrowEnabled);
  const invalidate = useInvalidateMoney();
  const params = useLocalSearchParams<{ barcodeId?: string; field?: string }>();
  const [amount, setAmount] = useState('');
  const [barcodeId, setBarcodeId] = useState(params.field === 'pay' ? '' : params.barcodeId ?? '');
  const [pin, setPin] = useState('');
  const [merchant, setMerchant] = useState(false);
  const [escrowCode, setEscrowCode] = useState('');
  const [error, setError] = useState('');
  const [barcodeShareError, setBarcodeShareError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [payMerchantBarcode, setPayMerchantBarcode] = useState(params.field === 'pay' ? params.barcodeId ?? '' : '');
  const [payAmount, setPayAmount] = useState('');
  const [buyerPayCode, setBuyerPayCode] = useState<{ id: string; expiresAt: string; plaintext: string } | null>(null);
  const [payMessage, setPayMessage] = useState('');
  const [incomingCodes, setIncomingCodes] = useState<Record<string, string>>({});
  const [incomingMessage, setIncomingMessage] = useState('');
  const incoming = useQuery({
    queryKey: ['escrow-pay-codes-incoming'],
    queryFn: () => request<{ items: { id: string; amount: string; expiresAt: string; buyerBarcodeId: string; buyerDisplayName: string | null }[] }>('/v1/me/escrow/pay-codes/incoming'),
    enabled: escrowEnabled,
    refetchInterval: 4_000,
  });
  const buyerStatus = useQuery({
    queryKey: ['escrow-pay-code', buyerPayCode?.id],
    queryFn: () => request<{ status: string }>(`/v1/me/escrow/pay-codes/${buyerPayCode!.id}`),
    enabled: buyerPayCode !== null && payMessage === '',
    refetchInterval: 3_000,
  });
  useEffect(() => {
    if (params.barcodeId === undefined) return;
    if (params.field === 'pay') setPayMerchantBarcode(params.barcodeId);
    else setBarcodeId(params.barcodeId);
  }, [params.barcodeId, params.field]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const status = buyerStatus.data?.status;
    if (status === undefined || status === 'ACTIVE' || payMessage !== '') return;
    setPayMessage(status === 'USED' ? t.escrow.payDone : status === 'EXPIRED' ? t.escrow.payExpired : t.escrow.payCancelled);
    void invalidate();
  }, [buyerStatus.data?.status, invalidate, payMessage, t.escrow]);
  if (balance.isLoading) return <LoadingScreen />;
  const submitTransfer = async () => {
    setError('');
    try {
      const stepUp = pin || await getStepUpPin();
      if (!stepUp) { setError(t.operationPinRequired); return; }
      await request('/v1/me/transfers', { method: 'POST', body: { toBarcodeId: barcodeId, amountCoupons: amount, idempotencyKey: `mobile-${Date.now()}`, pin: stepUp } });
      setAmount(''); setPin(''); await invalidate();
    } catch (cause) { setError(mapApiError(cause, t)); }
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
    } catch (cause) { setError(mapApiError(cause, t)); }
  };
  const paySeller = async () => {
    setPayMessage('');
    try {
      parseUsdtAmount(payAmount);
      const stepUp = await getStepUpPin();
      if (!stepUp) { setPayMessage(t.operationPinRequired); return; }
      const code = await randomFourDigitCode();
      const response = await request<{ id: string; expiresAt: string }>('/v1/me/escrow/pay-codes', { method: 'POST', body: { code, merchantBarcodeId: payMerchantBarcode, amount: payAmount, pin: stepUp } });
      setBuyerPayCode({ ...response, plaintext: code });
      setPayAmount('');
      await invalidate();
    } catch (cause) { setPayMessage(mapApiError(cause, t)); }
  };
  const cancelBuyerPayCode = async () => {
    if (buyerPayCode === null) return;
    try {
      await request(`/v1/me/escrow/pay-codes/${buyerPayCode.id}`, { method: 'DELETE' });
      setPayMessage(t.escrow.payCancelled);
      setBuyerPayCode(null);
      await invalidate();
    } catch (cause) { setPayMessage(mapApiError(cause, t)); }
  };
  const settleIncoming = async (item: { id: string }) => {
    setIncomingMessage('');
    try {
      const code = incomingCodes[item.id] ?? '';
      const stepUp = await getStepUpPin();
      if (!stepUp) { setIncomingMessage(t.operationPinRequired); return; }
      await request('/v1/me/escrow/settlements', { method: 'POST', body: { payCodeId: item.id, code, pin: stepUp, idempotencyKey: `mobile-incoming-${item.id}-${Date.now()}` } });
      setIncomingMessage(t.escrow.incomingSettled);
      setIncomingCodes((current) => ({ ...current, [item.id]: '' }));
      await invalidate();
      await incoming.refetch();
    } catch (cause) { setIncomingMessage(mapApiError(cause, t)); }
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
      {escrowEnabled ? <Pressable onPress={() => router.push({ pathname: '/scan', params: { returnTo: '/(tabs)', field: 'pay' } })} style={styles.button}><Text style={styles.buttonText}>{t.escrow.buyTitle}</Text></Pressable> : null}
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
      {escrowEnabled && (incoming.data?.items.length ?? 0) > 0 ? <View style={styles.card}>
        <Text style={styles.heading}>{t.escrow.incomingTitle}</Text>
        {incoming.data?.items.map((item) => <View key={item.id} style={styles.card}>
          <Text style={styles.heading}>{t.escrow.incomingFrom(item.buyerDisplayName ?? item.buyerBarcodeId)}</Text>
          <Text style={styles.muted}>{item.buyerBarcodeId}</Text>
          <Text style={styles.text}>{t.escrow.incomingAmount}: {item.amount} USDT</Text>
          <TextInput value={incomingCodes[item.id] ?? ''} onChangeText={(value) => setIncomingCodes((current) => ({ ...current, [item.id]: value.replace(/\D/g, '').slice(0, 4) }))} placeholder={t.escrow.incomingCodePlaceholder} style={styles.input} keyboardType="number-pad" secureTextEntry />
          <Pressable onPress={() => void settleIncoming(item)} style={styles.button}><Text style={styles.buttonText}>{t.escrow.incomingConfirm}</Text></Pressable>
        </View>)}
        {incomingMessage ? <Text style={styles.notice}>{incomingMessage}</Text> : null}
      </View> : null}
      <View style={styles.card}>
        <Text style={styles.muted}>{t.balance}</Text>
        <Text style={{ ...styles.title, fontSize: 40 }}>{formatCoupons(balance.data?.coupons ?? '0', language)}</Text>
        <Text style={styles.muted}>{member?.displayName ?? profile.data?.displayName ?? ''}</Text>
      </View>
      {escrowEnabled ? <View style={styles.card}>
        <Text style={styles.heading}>{t.escrow.payTitle}</Text>
        <TextInput value={payMerchantBarcode} onChangeText={setPayMerchantBarcode} placeholder={t.escrow.payMerchantBarcode} style={styles.input} />
        <Pressable onPress={() => router.push({ pathname: '/scan', params: { returnTo: '/(tabs)', field: 'pay' } })} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.scanQr}</Text></Pressable>
        <TextInput value={payAmount} onChangeText={setPayAmount} placeholder={t.escrow.payAmountUsdt} style={styles.input} keyboardType="decimal-pad" autoFocus={payMerchantBarcode !== '' && buyerPayCode === null} />
        <Pressable onPress={() => void (buyerPayCode === null ? paySeller() : cancelBuyerPayCode())} style={styles.button}><Text style={styles.buttonText}>{buyerPayCode === null ? t.escrow.payNow : t.cancel}</Text></Pressable>
        {buyerPayCode !== null ? <>
          <Text style={styles.muted}>{t.escrow.payCodeShow}</Text>
          <Text style={{ ...styles.title, textAlign: 'center', letterSpacing: 8 }}>{buyerPayCode.plaintext}</Text>
          <Text style={styles.muted}>{t.escrow.payWaitingSeller}</Text>
          <Text style={styles.muted}>{formatEscrowCountdown(buyerPayCode.expiresAt, now)}</Text>
        </> : null}
        {payMessage ? <Text style={payMessage === t.escrow.payDone ? styles.notice : styles.danger}>{payMessage}</Text> : null}
      </View> : null}
      {member?.isRestricted ? <View style={styles.card}><Text style={styles.danger}>{t.restricted}</Text><Text style={styles.text}>{t.restrictedExplanation}</Text></View> : null}
      {ownBarcodeId ? <View style={styles.card}>
        <Text style={styles.heading}>{t.myBarcode}</Text>
        <Text style={styles.muted}>{t.myBarcodeInstructions}</Text>
        <View style={styles.barcodeQr}>
          <QRCode value={ownBarcodeId} size={220} color={colors.ink} backgroundColor={colors.card} />
          <Text selectable style={{ ...styles.heading, textAlign: 'center', letterSpacing: 1 }}>{ownBarcodeId}</Text>
        </View>
        <Pressable onPress={() => void shareBarcode()} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>{t.shareBarcode}</Text>
        </Pressable>
        {barcodeShareError ? <Text style={styles.danger}>{barcodeShareError}</Text> : null}
      </View> : null}
      {escrowEnabled ? <Pressable onPress={() => router.push('/tether')} style={styles.card}>
        <Text style={styles.heading}>{t.escrow.title}</Text>
        <Text style={styles.muted}>{t.escrow.locked}: {formatMicroUsdt(escrowBalance.data?.lockedMicroUsdt ?? '0', language)} USDT</Text>
        <Text style={styles.muted}>{t.escrow.available}: {formatMicroUsdt(escrowBalance.data?.availableMicroUsdt ?? '0', language)} USDT</Text>
      </Pressable> : null}
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
