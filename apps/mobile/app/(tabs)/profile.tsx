import React, { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { request, ApiError, LockedError } from '../../src/api/client';
import { useSession } from '../../src/auth/session';
import { useAvailability, useBalance, useInvalidateMoney, useMember } from '../../src/hooks';
import { Page, LoadingScreen } from '../../src/components/Screen';
import { formatCoupons, formatDate } from '../../src/lib/pin';
import { fa } from '../../src/i18n/fa';
import { styles } from '../../src/styles';

export default function Profile() {
  const { signOut, getStepUpPin } = useSession();
  const member = useMember();
  const balance = useBalance();
  const availability = useAvailability();
  const invalidate = useInvalidateMoney();
  const [displayName, setDisplayName] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [destination, setDestination] = useState('');
  const [pin, setPin] = useState('');
  const [email, setEmail] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [error, setError] = useState('');
  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: () => request<{ items: Array<{ id: string; label: string; current: boolean; lastSeenAt: string }> }>('/v1/me/devices'),
  });
  if (member.isLoading || balance.isLoading) return <LoadingScreen />;
  const saveName = async () => {
    try { await request('/v1/me', { method: 'PATCH', body: { displayName } }); await invalidate(); } catch (cause) { setError(cause instanceof ApiError ? cause.message : fa.unknownError); }
  };
  const withdraw = async () => {
    try {
      const stepUp = pin || await getStepUpPin();
      if (!stepUp) { setError('رمز برای این عملیات لازم است.'); return; }
      await request('/v1/me/withdrawals', { method: 'POST', body: { destinationAddress: destination, couponsGross: withdrawAmount, pin: stepUp } });
      setPin(''); setError('درخواست برداشت ثبت شد. واجد شرایط بودن از ۱۶۸ ساعت دیگر بررسی می‌شود.'); await invalidate();
    } catch (cause) { setError(cause instanceof LockedError ? `${cause.message} (${cause.retryAfter} ثانیه)` : cause instanceof ApiError ? cause.message : fa.unknownError); }
  };
  const requestEmail = async () => {
    try { await request('/v1/me/email', { method: 'POST', body: { email } }); setError('کد تأیید ایمیل ارسال شد.'); } catch (cause) { setError(cause instanceof ApiError ? cause.message : fa.unknownError); }
  };
  const verifyEmail = async () => {
    try { await request('/v1/me/email/verify', { method: 'POST', body: { code: emailCode } }); setEmailCode(''); await invalidate(); } catch (cause) { setError(cause instanceof ApiError ? cause.message : fa.unknownError); }
  };
  const changePin = async () => {
    try { await request('/v1/me/pin', { method: 'POST', body: { currentPin, newPin } }); setCurrentPin(''); setNewPin(''); setError('رمز تغییر کرد؛ نشست‌های دستگاه‌های دیگر خارج شدند.'); } catch (cause) { setError(cause instanceof ApiError ? cause.message : fa.unknownError); }
  };
  const current = member.data;
  return (
    <Page>
      <Text style={styles.title}>{fa.profile}</Text>
      <View style={styles.card}>
        <Text style={styles.heading}>{current?.displayName ?? 'عضو'}</Text>
        <Text style={styles.text}>تلفن: {current?.phone ? `••••${current.phone.slice(-4)}` : '••••'}</Text>
        <Text style={styles.text}>ایمیل: {current?.email ?? 'ثبت نشده'}</Text>
        <Text style={styles.muted}>KYC: {current?.kycStatus}</Text>
        <TextInput value={displayName} onChangeText={setDisplayName} placeholder={fa.displayName} style={styles.input} />
        <Pressable onPress={() => void saveName()} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{fa.save}</Text></Pressable>
      </View>
      <View style={styles.card}>
        <Text style={styles.heading}>{fa.email}</Text>
        <TextInput value={email} onChangeText={setEmail} placeholder={fa.email} style={styles.input} keyboardType="email-address" autoCapitalize="none" />
        <Pressable onPress={() => void requestEmail()} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>ارسال کد</Text></Pressable>
        <TextInput value={emailCode} onChangeText={(value) => setEmailCode(value.replace(/\D/g, '').slice(0, 6))} placeholder="کد شش رقمی" style={styles.input} keyboardType="number-pad" />
        <Pressable onPress={() => void verifyEmail()} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{fa.verify}</Text></Pressable>
      </View>
      <View style={styles.card}>
        <Text style={styles.heading}>{fa.pin}</Text>
        <TextInput value={currentPin} onChangeText={(value) => setCurrentPin(value.replace(/\D/g, '').slice(0, 4))} placeholder="رمز فعلی" style={styles.input} keyboardType="number-pad" secureTextEntry />
        <TextInput value={newPin} onChangeText={(value) => setNewPin(value.replace(/\D/g, '').slice(0, 4))} placeholder="رمز جدید" style={styles.input} keyboardType="number-pad" secureTextEntry />
        <Pressable onPress={() => void changePin()} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>تغییر رمز</Text></Pressable>
      </View>
      <View style={styles.card}>
        <Text style={styles.heading}>{fa.devices}</Text>
        {(devices.data?.items ?? []).map((device) => (
          <View key={device.id} style={styles.row}>
            <Text style={styles.muted}>{device.label} · {device.current ? 'این دستگاه' : formatDate(device.lastSeenAt)}</Text>
            {!device.current ? <Pressable onPress={() => void request(`/v1/me/devices/${device.id}`, { method: 'DELETE' }).then(() => void devices.refetch())}><Text style={styles.danger}>لغو</Text></Pressable> : null}
          </View>
        ))}
      </View>
      <View style={styles.card}>
        <Text style={styles.heading}>{fa.depositAddress}</Text>
        <Text selectable style={styles.text}>{balance.data?.depositAddress ?? 'هنوز اختصاص داده نشده'}</Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.heading}>{fa.withdrawal}</Text>
        {availability.data ? <>
          <Text style={styles.text}>وثیقه کل: {formatCoupons(availability.data.totalCollateralCoupons)}</Text>
          <Text style={styles.text}>قفل ضمانت: {formatCoupons(availability.data.lockedGuaranteeCoupons)}</Text>
          <Text style={styles.text}>بدهی: {formatCoupons(availability.data.outstandingDebtCoupons)}</Text>
          <Text style={styles.heading}>قابل برداشت: {formatCoupons(availability.data.availableToWithdrawCoupons)}</Text>
          {availability.data.blockers.map((blocker) => <Text key={blocker} style={styles.danger}>{blocker}</Text>)}
        </> : null}
        <TextInput value={withdrawAmount} onChangeText={(value) => setWithdrawAmount(value.replace(/\D/g, ''))} placeholder={fa.amount} style={styles.input} keyboardType="number-pad" />
        <TextInput value={destination} onChangeText={setDestination} placeholder="آدرس مقصد" style={styles.input} />
        <TextInput value={pin} onChangeText={(value) => setPin(value.replace(/\D/g, '').slice(0, 4))} placeholder={fa.pin} style={styles.input} keyboardType="number-pad" secureTextEntry />
        <Pressable onPress={() => void withdraw()} style={styles.button}><Text style={styles.buttonText}>ثبت درخواست برداشت</Text></Pressable>
      </View>
      <View style={styles.card}><Text style={styles.muted}>{fa.kycLater}</Text></View>
      {error ? <Text style={styles.danger}>{error}</Text> : null}
      <Pressable onPress={() => void signOut()} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{fa.logout}</Text></Pressable>
    </Page>
  );
}
