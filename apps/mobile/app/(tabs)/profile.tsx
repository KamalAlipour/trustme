import React, { useEffect, useRef, useState } from 'react';
import { FlatList, Modal, Pressable, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { request, ApiError, LockedError } from '../../src/api/client';
import type { WithdrawalQuote } from '../../src/api/types';
import { useSession } from '../../src/auth/session';
import { useAvailability, useBalance, useIdentity, useInvalidateMoney, useMember } from '../../src/hooks';
import { Page, LoadingScreen } from '../../src/components/Screen';
import { formatCoupons, formatDate, formatMicroUsdt } from '../../src/lib/format';
import { isPlausiblePhoneNumber } from '../../src/lib/phone-validation';
import { useTranslation } from '../../src/i18n';
import { styles } from '../../src/styles';
import { ISO_ALPHA2_COUNTRIES } from '../../src/lib/countries';
import { isValidEmail, isValidEmailCode, submitEmailAction } from '../../src/lib/email-validation';
import { LiveIdentityCapture } from '../../src/components/LiveIdentityCapture';

export default function Profile() {
  const { t, language, setLanguage } = useTranslation();
  const { signOut, getStepUpPin, refreshSetup, setup, biometric } = useSession();
  const member = useMember();
  const identity = useIdentity();
  const balance = useBalance();
  const availability = useAvailability();
  const invalidate = useInvalidateMoney();
  const [displayName, setDisplayName] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [destination, setDestination] = useState('');
  const [pin, setPin] = useState('');
  const [email, setEmail] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [phonePin, setPhonePin] = useState('');
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [phoneFeedback, setPhoneFeedback] = useState('');
  const [phoneError, setPhoneError] = useState('');
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [pinEditing, setPinEditing] = useState(false);
  const [nationalCode, setNationalCode] = useState('');
  const [country, setCountry] = useState('');
  const [countryLoading, setCountryLoading] = useState(false);
  const [countryPickerOpen, setCountryPickerOpen] = useState(false);
  const [countrySearch, setCountrySearch] = useState('');
  const [identityLoading, setIdentityLoading] = useState(false);
  const [eligibleAt, setEligibleAt] = useState<string | null>(null);
  const [withdrawalQuote, setWithdrawalQuote] = useState<WithdrawalQuote | null>(null);
  const [withdrawalQuoteError, setWithdrawalQuoteError] = useState('');
  const [withdrawalQuoteLoading, setWithdrawalQuoteLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const phoneIsValid = isPlausiblePhoneNumber(newPhone);
  const [emailFeedback, setEmailFeedback] = useState('');
  const [emailError, setEmailError] = useState('');
  const [emailBusy, setEmailBusy] = useState<'send' | 'verify' | null>(null);
  const previousLanguage = useRef(language);
  const emailIsValid = isValidEmail(email);
  const emailCodeIsValid = isValidEmailCode(emailCode);
  const updateWithdrawAmount = (value: string) => {
    const amount = value.replace(/\D/g, '');
    setWithdrawAmount(amount);
    setWithdrawalQuote(null);
    setWithdrawalQuoteError('');
    setWithdrawalQuoteLoading(amount.length > 0);
  };
  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: () => request<{ items: Array<{ id: string; label: string; current: boolean; lastSeenAt: string }> }>('/v1/me/devices'),
  });
  useEffect(() => {
    if (previousLanguage.current !== language) {
      setNotice(t.languageRestartNotice(language));
      previousLanguage.current = language;
    }
  }, [language, t]);
  useEffect(() => {
    const amount = withdrawAmount.trim();
    if (amount.length === 0) {
      setWithdrawalQuote(null);
      setWithdrawalQuoteError('');
      setWithdrawalQuoteLoading(false);
      return;
    }
    setWithdrawalQuote(null);
    setWithdrawalQuoteError('');
    setWithdrawalQuoteLoading(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      void request<WithdrawalQuote>(`/v1/me/withdrawals/quote?couponsGross=${encodeURIComponent(amount)}`)
        .then((quote) => {
          if (!cancelled) setWithdrawalQuote(quote);
        })
        .catch((cause: unknown) => {
          if (!cancelled) setWithdrawalQuoteError(cause instanceof ApiError ? cause.message : t.quoteUnavailable);
        })
        .finally(() => {
          if (!cancelled) setWithdrawalQuoteLoading(false);
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [withdrawAmount, t]);
  if (member.isLoading || balance.isLoading) return <LoadingScreen />;
  const saveName = async () => {
    setError(''); setNotice('');
    try { await request('/v1/me', { method: 'PATCH', body: { displayName } }); setNotice(t.nameSaved); await invalidate(); } catch (cause) { setError(cause instanceof ApiError ? cause.message : t.unknownError); }
  };
  const withdraw = async () => {
    setError(''); setNotice('');
    try {
      const stepUp = pin || await getStepUpPin();
      if (!stepUp) { setError(t.operationPinRequired); return; }
      const withdrawal = await request<{ eligibleAt: string }>('/v1/me/withdrawals', { method: 'POST', body: { destinationAddress: destination, couponsGross: withdrawAmount, pin: stepUp } });
      setPin(''); setEligibleAt(withdrawal.eligibleAt); setNotice(t.withdrawalSubmitted); await invalidate();
    } catch (cause) { setError(cause instanceof LockedError ? `${cause.message} (${t.lockedSeconds(cause.retryAfter)})` : cause instanceof ApiError ? cause.message : t.unknownError); }
  };
  const requestEmail = async () => {
    if (!emailIsValid || emailBusy !== null) return;
    setEmailFeedback(''); setEmailError(''); setEmailBusy('send');
    try {
      const message = await submitEmailAction('send', email, async (value) => {
        await request('/v1/me/email', { method: 'POST', body: { email: value } });
      }, t);
      if (message !== null) setEmailFeedback(message);
    } catch (cause) { setEmailError(cause instanceof ApiError ? cause.message : t.unknownError); } finally { setEmailBusy(null); }
  };
  const savePhone = async () => {
    if (!phoneIsValid || phonePin.length !== 4 || phoneBusy) return;
    setPhoneFeedback(''); setPhoneError(''); setPhoneBusy(true);
    try {
      await request('/v1/me/phone', { method: 'POST', body: { phone: newPhone.trim(), pin: phonePin } });
      setNewPhone('');
      setPhonePin('');
      setPhoneFeedback(t.phoneSaved);
      await invalidate();
    } catch (cause) {
      setPhoneError(cause instanceof ApiError ? cause.message : t.unknownError);
    } finally {
      setPhoneBusy(false);
    }
  };
  const verifyEmail = async () => {
    if (!emailCodeIsValid || emailBusy !== null) return;
    setEmailFeedback(''); setEmailError(''); setEmailBusy('verify');
    try {
      const message = await submitEmailAction('verify', emailCode, async (value) => {
        await request('/v1/me/email/verify', { method: 'POST', body: { code: value } });
      }, t);
      if (message !== null) { setEmailCode(''); setEmailFeedback(message); await invalidate(); }
    } catch (cause) { setEmailError(cause instanceof ApiError ? cause.message : t.unknownError); } finally { setEmailBusy(null); }
  };
  const changePin = async () => {
    setError(''); setNotice('');
    try { await request('/v1/me/pin', { method: 'POST', body: { currentPin, newPin } }); setCurrentPin(''); setNewPin(''); setNotice(t.pinChanged); setPinEditing(false); } catch (cause) { setError(cause instanceof ApiError ? cause.message : t.unknownError); }
  };
  const enableBiometric = async () => {
    setError(''); setNotice('');
    try {
      const stepUp = await getStepUpPin();
      if (!stepUp) { setError(t.biometricCancelled); return; }
      await request('/v1/member/security/biometric', {
        method: 'POST',
        body: { pin: stepUp, biometricEnrolled: true },
      });
      await refreshSetup();
      setNotice(t.biometricEnabled);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t.unknownError);
    }
  };
  const verifyIdentity = async () => {
    setError(''); setNotice(''); setIdentityLoading(true);
    try {
      await request('/v1/me/identity', { method: 'POST', body: { nationalCode } });
      setNationalCode('');
      setNotice(t.identityVerificationSubmitted);
      await invalidate();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t.unknownError);
    } finally {
      setIdentityLoading(false);
    }
  };
  const saveCountry = async () => {
    setError(''); setNotice(''); setCountryLoading(true);
    try {
      await request('/v1/me/country', { method: 'PUT', body: { country } });
      setNotice(t.identityCountrySaved);
      await invalidate();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t.unknownError);
    } finally {
      setCountryLoading(false);
    }
  };
  const current = member.data;
  const selectedCountry = country || current?.country || '';
  const filteredCountries = ISO_ALPHA2_COUNTRIES.filter(({ code, name }) => {
    const query = countrySearch.trim().toLowerCase();
    return query.length === 0 || code.toLowerCase().includes(query) || name.toLowerCase().includes(query);
  });
  const identityStatus = current?.identityVerification.status ?? 'UNVERIFIED';
  const identityCopy = current?.country === null || current?.country === undefined
    ? t.countryRequired
    : identity.data?.mode === 'MANUAL'
      ? identity.data.review?.status === 'PENDING'
        ? t.manualReviewPending
        : identity.data.review?.status === 'REJECTED'
          ? `${t.manualReviewRejected}${identity.data.review.decisionNote ? ` ${identity.data.review.decisionNote}` : ''}`
          : `${t.manualIdentity}${identity.data.plannedProviderLabel ? ` ${t.plannedIdentity(identity.data.plannedProviderLabel)}` : ''}`
      : identityStatus === 'VERIFIED'
    ? `${t.identityVerified}${current?.identityVerification.verifiedAt ? ` ${t.identityVerifiedAt(formatDate(current.identityVerification.verifiedAt, language))}` : ''}`
    : identityStatus === 'MISMATCH' ? t.identityMismatch : identityStatus === 'INCONCLUSIVE' ? t.identityInconclusive : t.identityUnverified;
  return (
    <Page>
      <Text style={styles.title}>{t.profile}</Text>
      <View style={styles.card}>
        <Text style={styles.heading}>{t.language}</Text>
        <View style={styles.languageRow}>
          <Pressable onPress={() => void setLanguage('en')} style={language === 'en' ? styles.languageActive : styles.languageButton}><Text style={styles.secondaryButtonText}>{t.english}</Text></Pressable>
          <Pressable onPress={() => void setLanguage('fa')} style={language === 'fa' ? styles.languageActive : styles.languageButton}><Text style={styles.secondaryButtonText}>{t.persian}</Text></Pressable>
        </View>
      </View>
      <View style={styles.card}>
        <Text style={styles.heading}>{t.country}</Text>
        <Pressable disabled={identityStatus === 'VERIFIED'} onPress={() => setCountryPickerOpen(true)} style={styles.input}><Text style={selectedCountry ? styles.text : styles.muted}>{selectedCountry || t.selectCountry}</Text></Pressable>
        {selectedCountry && selectedCountry !== current?.country ? <Pressable disabled={countryLoading} onPress={() => void saveCountry()} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.saveCountry}</Text></Pressable> : null}
        {identityStatus === 'VERIFIED' ? <Text style={styles.muted}>{t.countryLocked}</Text> : null}
        <Modal visible={countryPickerOpen} animationType="slide" onRequestClose={() => setCountryPickerOpen(false)}>
          <View style={styles.card}>
            <Text style={styles.heading}>{t.selectCountry}</Text>
            <TextInput value={countrySearch} onChangeText={setCountrySearch} placeholder={t.searchCountries} style={styles.input} autoFocus />
            <FlatList
              data={filteredCountries}
              keyExtractor={({ code }) => code}
              ListEmptyComponent={<Text style={styles.muted}>{t.noCountriesFound}</Text>}
              renderItem={({ item }) => <Pressable onPress={() => { setCountry(item.code); setCountryPickerOpen(false); }} style={styles.row}><Text style={styles.text}>{item.name} ({item.code})</Text></Pressable>}
            />
            <Pressable onPress={() => setCountryPickerOpen(false)} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.cancel}</Text></Pressable>
          </View>
        </Modal>
      </View>
      <View style={styles.card}>
        <Pressable onPress={() => router.push('/about')} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.about}</Text></Pressable>
      </View>
      {setup?.biometricPending && biometric ? <View style={styles.card}>
        <Text style={styles.heading}>{t.securitySetup}</Text>
        <Text style={styles.text}>{t.biometricQuestion}</Text>
        <Pressable onPress={() => void enableBiometric()} style={styles.button}><Text style={styles.buttonText}>{t.enableBiometricSignIn}</Text></Pressable>
      </View> : null}
      <View style={styles.card}>
        <Text style={styles.heading}>{current?.displayName ?? t.member}</Text>
        <Text style={styles.text}>{t.phoneLabel}: {current?.phone ?? t.phoneUnavailable}</Text>
        <TextInput
          value={newPhone}
          onChangeText={(value) => { setNewPhone(value); setPhoneFeedback(''); setPhoneError(''); }}
          placeholder={t.phone}
          style={styles.input}
          keyboardType="phone-pad"
          textContentType="telephoneNumber"
          autoComplete="tel"
        />
        <TextInput
          value={phonePin}
          onChangeText={(value) => setPhonePin(value.replace(/\D/g, '').slice(0, 4))}
          placeholder={t.pin}
          style={styles.input}
          keyboardType="number-pad"
          secureTextEntry
        />
        {!phoneIsValid && newPhone.trim().length > 0 ? <Text style={styles.danger}>{t.invalidPhone}</Text> : null}
        <Pressable
          disabled={!phoneIsValid || phonePin.length !== 4 || phoneBusy}
          onPress={() => void savePhone()}
          style={[styles.secondaryButton, !phoneIsValid || phonePin.length !== 4 || phoneBusy ? styles.buttonDisabled : null]}
        >
          <Text style={styles.secondaryButtonText}>{phoneBusy ? t.savingPhone : t.savePhone}</Text>
        </Pressable>
        {phoneFeedback ? <Text style={styles.notice}>{phoneFeedback}</Text> : null}
        {phoneError ? <Text style={styles.danger}>{phoneError}</Text> : null}
        <Text style={styles.text}>{t.emailLabel}: {current?.email ?? t.notRegistered}</Text>
        <Text style={styles.muted}>KYC: {current?.kycStatus}</Text>
        <TextInput value={displayName} onChangeText={setDisplayName} placeholder={t.displayName} style={styles.input} />
        <Pressable onPress={() => void saveName()} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.save}</Text></Pressable>
      </View>
      <View style={styles.card}>
        <Text style={styles.heading}>{t.email}</Text>
        <TextInput value={email} onChangeText={(value) => { setEmail(value); setEmailFeedback(''); setEmailError(''); }} placeholder={t.email} style={styles.input} keyboardType="email-address" autoCapitalize="none" />
        {!emailIsValid && email.trim().length > 0 ? <Text style={styles.danger}>{t.invalidEmail}</Text> : null}
        <Pressable disabled={!emailIsValid || emailBusy !== null} onPress={() => void requestEmail()} style={[styles.secondaryButton, !emailIsValid || emailBusy !== null ? styles.buttonDisabled : null]}><Text style={styles.secondaryButtonText}>{emailBusy === 'send' ? t.sendingEmailCode : t.sendCode}</Text></Pressable>
        <TextInput value={emailCode} onChangeText={(value) => setEmailCode(value.replace(/\D/g, '').slice(0, 6))} placeholder={t.sixDigitCode} style={styles.input} keyboardType="number-pad" />
        <Pressable disabled={!emailCodeIsValid || emailBusy !== null} onPress={() => void verifyEmail()} style={[styles.secondaryButton, !emailCodeIsValid || emailBusy !== null ? styles.buttonDisabled : null]}><Text style={styles.secondaryButtonText}>{emailBusy === 'verify' ? t.verifyingEmail : t.verify}</Text></Pressable>
        {emailFeedback ? <Text style={styles.notice}>{emailFeedback}</Text> : null}
        {emailError ? <Text style={styles.danger}>{emailError}</Text> : null}
      </View>
      <View style={styles.card}>
        <Text style={styles.heading}>{t.pin}</Text>
        {pinEditing ? <>
          <TextInput value={currentPin} onChangeText={(value) => setCurrentPin(value.replace(/\D/g, '').slice(0, 4))} placeholder={t.currentPin} style={styles.input} keyboardType="number-pad" secureTextEntry />
          <TextInput value={newPin} onChangeText={(value) => setNewPin(value.replace(/\D/g, '').slice(0, 4))} placeholder={t.newPin} style={styles.input} keyboardType="number-pad" secureTextEntry />
          <Pressable
            disabled={currentPin.length !== 4 || newPin.length !== 4}
            onPress={() => void changePin()}
            style={[styles.button, currentPin.length !== 4 || newPin.length !== 4 ? styles.buttonDisabled : null]}
          >
            <Text style={styles.buttonText}>{t.changePin}</Text>
          </Pressable>
          <Pressable onPress={() => { setCurrentPin(''); setNewPin(''); setPinEditing(false); }} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>{t.cancel}</Text>
          </Pressable>
        </> : <>
          <Text style={styles.notice}>{t.pinIsSet}</Text>
          <Pressable onPress={() => setPinEditing(true)} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>{t.changePin}</Text>
          </Pressable>
        </>}
      </View>
      <View style={styles.card}>
        <Text style={styles.heading}>{t.devices}</Text>
        {(devices.data?.items ?? []).map((device) => (
          <View key={device.id} style={styles.row}>
            <Text style={styles.muted}>{device.label} · {device.current ? t.currentDevice : formatDate(device.lastSeenAt, language)}</Text>
            {!device.current ? <Pressable onPress={() => void request(`/v1/me/devices/${device.id}`, { method: 'DELETE' }).then(() => void devices.refetch())}><Text style={styles.danger}>{t.deviceCancel}</Text></Pressable> : null}
          </View>
        ))}
      </View>
      <View style={styles.card}>
        <Text style={styles.heading}>{t.depositAddress}</Text>
        <Text selectable style={styles.text}>{balance.data?.depositAddress ?? t.notAssigned}</Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.heading}>{t.withdrawal}</Text>
        {availability.data ? <>
          <Text style={styles.text}>{t.totalCollateral}: {formatCoupons(availability.data.totalCollateralCoupons, language)}</Text>
          <Text style={styles.text}>{t.lockedGuarantee}: {formatCoupons(availability.data.lockedGuaranteeCoupons, language)}</Text>
          <Text style={styles.text}>{t.debt}: {formatCoupons(availability.data.outstandingDebtCoupons, language)}</Text>
          <Text style={styles.heading}>{t.availableToWithdraw}: {formatCoupons(availability.data.availableToWithdrawCoupons, language)}</Text>
          {availability.data.blockers.map((blocker) => <Text key={blocker} style={styles.danger}>{blocker === 'identity_unverified' ? t.identityWithdrawalRequired : blocker}</Text>)}
        </> : null}
        <TextInput value={withdrawAmount} onChangeText={updateWithdrawAmount} placeholder={t.amount} style={styles.input} keyboardType="number-pad" />
        {withdrawalQuoteLoading ? <Text style={styles.muted}>{t.quoteLoading}</Text> : null}
        {withdrawalQuoteError ? <Text style={styles.danger}>{withdrawalQuoteError}</Text> : null}
        {withdrawalQuote ? <>
          <Text style={styles.text}>{t.platformFee}: {formatMicroUsdt(withdrawalQuote.feeMicroUsdt, language)} USDT</Text>
          <Text style={styles.heading}>{t.amountReceived}: {formatMicroUsdt(withdrawalQuote.netMicroUsdt, language)} USDT</Text>
        </> : null}
        <TextInput value={destination} onChangeText={setDestination} placeholder={t.destinationAddress} style={styles.input} />
        <TextInput value={pin} onChangeText={(value) => setPin(value.replace(/\D/g, '').slice(0, 4))} placeholder={t.pin} style={styles.input} keyboardType="number-pad" secureTextEntry />
        <Pressable disabled={withdrawalQuote === null || withdrawalQuoteLoading} onPress={() => void withdraw()} style={styles.button}><Text style={styles.buttonText}>{t.submitWithdrawal}</Text></Pressable>
        {eligibleAt ? <Text style={styles.muted}>{t.eligibleAt}: {formatDate(eligibleAt, language)}</Text> : null}
      </View>
      <View style={styles.card}>
        <Text style={styles.heading}>{t.identityVerification}</Text>
        <Text style={styles.text}>{identityCopy}</Text>
        {current?.country && identity.data?.mode === 'MANUAL' && identity.data.review?.status !== 'PENDING' && identityStatus !== 'VERIFIED' ? <>
          <LiveIdentityCapture onSubmitted={async () => { setNotice(t.manualReviewSubmitted); await invalidate(); }} />
        </> : null}
        {current?.country && identity.data?.mode === 'AUTOMATED' && identityStatus !== 'VERIFIED' ? <>
          <TextInput
            value={nationalCode}
            onChangeText={(value) => setNationalCode(value.replace(/\D/g, '').slice(0, 10))}
            placeholder={t.nationalCode}
            style={styles.input}
            keyboardType="number-pad"
            maxLength={10}
          />
          <Pressable disabled={identityLoading || nationalCode.length !== 10} onPress={() => void verifyIdentity()} style={styles.button}><Text style={styles.buttonText}>{t.verifyIdentity}</Text></Pressable>
        </> : null}
      </View>
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      {error ? <Text style={styles.danger}>{error}</Text> : null}
      <Pressable onPress={() => void signOut()} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.logout}</Text></Pressable>
    </Page>
  );
}
