import React, { useState } from 'react';
import { Modal, Pressable, Text, TextInput, View } from 'react-native';
import { request, ApiError } from '../../src/api/client';
import { useSession } from '../../src/auth/session';
import { useLoans, useInvalidateMoney } from '../../src/hooks';
import { Page, LoadingScreen } from '../../src/components/Screen';
import { randomFourDigitCode } from '../../src/lib/code';
import { greaterThan, nextInstallmentAmount } from '../../src/lib/coupons';
import { formatCoupons, formatDate } from '../../src/lib/format';
import { useTranslation } from '../../src/i18n';
import { styles } from '../../src/styles';
import { CharitySection } from '../../src/components/CharitySection';
import { HeaderIcons } from '../../src/components/HeaderIcons';
import { CreditRequestForm } from '../../src/components/CreditRequestForm';

export default function Lending() {
  const { t, direction, language } = useTranslation();
  const loans = useLoans();
  const invalidate = useInvalidateMoney();
  const { member, getStepUpPin } = useSession();
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [pins, setPins] = useState<Record<string, string>>({});
  const [repaymentAmounts, setRepaymentAmounts] = useState<Record<string, string>>({});
  const [revealedCode, setRevealedCode] = useState<string | null>(null);
  const [error, setError] = useState('');
  if (loans.isLoading) return <LoadingScreen />;
  const repay = async (loanId: string, amount: string) => {
    if (!isPositiveCoupons(amount)) { setError(t.repaymentPositive); return; }
    const loan = loans.data?.items.find((item) => item.id === loanId);
    if (!loan || greaterThan(amount, loan.outstandingCoupons)) { setError(t.repaymentExceedsDebt); return; }
    try { await request(`/v1/me/loans/${loanId}/repay`, { method: 'POST', body: { amountCoupons: amount, idempotencyKey: `mobile-repay-${Date.now()}` } }); await invalidate(); } catch (cause) { setError(cause instanceof ApiError ? cause.message : t.unknownError); }
  };
  const approve = async (guaranteeId: string) => {
    try {
      const pin = pins[guaranteeId] || await getStepUpPin();
      if (!pin) { setError(t.operationPinRequired); return; }
      const code = codes[guaranteeId] || await randomFourDigitCode();
      await request(`/v1/me/guarantees/${guaranteeId}/approve`, { method: 'POST', body: { code, pin } });
      setCodes((current) => ({ ...current, [guaranteeId]: code }));
      setRevealedCode(code);
      await invalidate();
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : t.unknownError); }
  };
  const activate = async (guaranteeId: string) => {
    try {
      if (!codes[guaranteeId]) { setError(t.activationCodeRequired); return; }
      await request(`/v1/me/guarantees/${guaranteeId}/activate`, { method: 'POST', body: { code: codes[guaranteeId] } });
      await invalidate();
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : t.unknownError); }
  };
  return (
    <Page>
      <View style={styles.row}><Text style={styles.title}>{t.lending}</Text><HeaderIcons /></View>
      <CreditRequestForm operationError={error} />
      {(loans.data?.items ?? []).map((loan) => (
        <View key={loan.id} style={styles.card}>
          <Text style={styles.heading}>{t.loanTitle(formatCoupons(loan.principalCoupons, language))}</Text>
          <Text style={styles.text}>{t.loanStatus(loan.status, formatCoupons(loan.outstandingCoupons, language))}</Text>
          {loan.guarantees.map((guarantee) => (
            <View key={guarantee.id} style={{ gap: 8 }}>
              <Text style={styles.muted}>{t.guaranteeStatus(formatCoupons(guarantee.amountCoupons, language), guarantee.status)}</Text>
              {guarantee.guarantorId === member?.id ? <>
                <TextInput value={pins[guarantee.id] ?? ''} onChangeText={(value) => setPins((current) => ({ ...current, [guarantee.id]: value.replace(/\D/g, '').slice(0, 4) }))} placeholder={t.pin} style={styles.input} keyboardType="number-pad" secureTextEntry />
                <Pressable onPress={() => void approve(guarantee.id)} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.approveGuarantee}</Text></Pressable>
              </> : null}
              {loan.borrowerId === member?.id ? <>
                <TextInput value={codes[guarantee.id] ?? ''} onChangeText={(value) => setCodes((current) => ({ ...current, [guarantee.id]: value.replace(/\D/g, '').slice(0, 4) }))} placeholder={t.receivedGuaranteeCode} style={styles.input} keyboardType="number-pad" />
                <Pressable onPress={() => void activate(guarantee.id)} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.activateGuarantee}</Text></Pressable>
              </> : null}
            </View>
          ))}
          {loan.outstandingCoupons !== '0' && loan.borrowerId === member?.id ? <>
            <TextInput
              value={repaymentAmounts[loan.id] ?? nextInstallmentAmount(loan)}
              onChangeText={(value) => setRepaymentAmounts((current) => ({ ...current, [loan.id]: value.replace(/\D/g, '') }))}
              placeholder={t.repaymentAmount}
              style={styles.input}
              keyboardType="number-pad"
            />
            <Pressable onPress={() => void repay(loan.id, repaymentAmounts[loan.id] ?? nextInstallmentAmount(loan))} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.payInstallment}</Text></Pressable>
          </> : null}
          <Text style={styles.muted}>{formatDate(loan.createdAt, language)}</Text>
        </View>
      ))}
      <CharitySection />
      <Modal visible={revealedCode !== null} animationType="slide">
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 24, padding: 24, direction }}>
          <Text style={styles.heading}>{t.readGuaranteeCode}</Text>
          <Text style={{ ...styles.title, fontSize: 46, letterSpacing: 10 }}>{revealedCode}</Text>
          <Pressable onPress={() => setRevealedCode(null)} style={styles.button}><Text style={styles.buttonText}>{t.close}</Text></Pressable>
        </View>
      </Modal>
    </Page>
  );
}

function isPositiveCoupons(value: string): boolean {
  return /^[1-9]\d*$/.test(value);
}
