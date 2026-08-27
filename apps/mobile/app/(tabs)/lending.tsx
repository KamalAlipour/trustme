import React, { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { request, ApiError } from '../../src/api/client';
import { useSession } from '../../src/auth/session';
import { useLoans, useInvalidateMoney, useContacts } from '../../src/hooks';
import { Page, LoadingScreen } from '../../src/components/Screen';
import { formatCoupons, formatDate } from '../../src/lib/pin';
import { fa } from '../../src/i18n/fa';
import { styles } from '../../src/styles';

export default function Lending() {
  const loans = useLoans();
  const contacts = useContacts();
  const invalidate = useInvalidateMoney();
  const { member, getStepUpPin } = useSession();
  const [principal, setPrincipal] = useState('');
  const [installments, setInstallments] = useState([{ dueAt: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), amountCoupons: '' }]);
  const [selectedGuarantors, setSelectedGuarantors] = useState<string[]>([]);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [pins, setPins] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  if (loans.isLoading) return <LoadingScreen />;
  const submitLoan = async () => {
    if (selectedGuarantors.length === 0) { setError('حداقل یک ضامن از مخاطبان انتخاب کنید.'); return; }
    try {
      const rows = installments.map((installment) => ({ dueAt: new Date(`${installment.dueAt}T23:59:59.000Z`).toISOString(), amountCoupons: installment.amountCoupons || principal }));
      await request('/v1/me/loans', { method: 'POST', body: { principalCoupons: principal, installments: rows, guarantors: selectedGuarantors.map((barcodeId) => ({ barcodeId, amountCoupons: principal })) } });
      setPrincipal(''); setSelectedGuarantors([]); setInstallments([{ dueAt: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), amountCoupons: '' }]); await invalidate();
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : fa.unknownError); }
  };
  const repay = async (loanId: string, amount: string) => {
    try { await request(`/v1/me/loans/${loanId}/repay`, { method: 'POST', body: { amountCoupons: amount, idempotencyKey: `mobile-repay-${Date.now()}` } }); await invalidate(); } catch (cause) { setError(cause instanceof ApiError ? cause.message : fa.unknownError); }
  };
  const approve = async (guaranteeId: string) => {
    try {
      const pin = pins[guaranteeId] || await getStepUpPin();
      if (!pin || !codes[guaranteeId]) { setError('کد ضمانت و رمز لازم است.'); return; }
      await request(`/v1/me/guarantees/${guaranteeId}/approve`, { method: 'POST', body: { code: codes[guaranteeId], pin } });
      await invalidate();
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : fa.unknownError); }
  };
  const activate = async (guaranteeId: string) => {
    try {
      if (!codes[guaranteeId]) { setError('کد فعال‌سازی لازم است.'); return; }
      await request(`/v1/me/guarantees/${guaranteeId}/activate`, { method: 'POST', body: { code: codes[guaranteeId] } });
      await invalidate();
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : fa.unknownError); }
  };
  return (
    <Page>
      <Text style={styles.title}>{fa.lending}</Text>
      <View style={styles.card}>
        <Text style={styles.heading}>درخواست وام</Text>
        <TextInput value={principal} onChangeText={(value) => setPrincipal(value.replace(/\D/g, ''))} placeholder={fa.amount} style={styles.input} keyboardType="number-pad" />
        {installments.map((installment, index) => <View key={`${index}-${installment.dueAt}`} style={{ gap: 8 }}>
          <Text style={styles.muted}>قسط {index + 1}</Text>
          <TextInput value={installment.amountCoupons} onChangeText={(value) => setInstallments((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, amountCoupons: value.replace(/\D/g, '') } : row))} placeholder="مقدار قسط (خالی = اصل)" style={styles.input} keyboardType="number-pad" />
          <TextInput value={installment.dueAt} onChangeText={(value) => setInstallments((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, dueAt: value } : row))} placeholder="تاریخ سررسید YYYY-MM-DD" style={styles.input} />
        </View>)}
        <Pressable onPress={() => setInstallments([...installments, { dueAt: new Date(Date.now() + (installments.length + 1) * 30 * 86400000).toISOString().slice(0, 10), amountCoupons: '' }])} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>افزودن قسط</Text></Pressable>
        <Text style={styles.muted}>ضامن‌ها</Text>
        {(contacts.data?.items ?? []).map((contact) => {
          const selected = selectedGuarantors.includes(contact.barcodeId);
          return <Pressable key={contact.id} onPress={() => setSelectedGuarantors(selected ? selectedGuarantors.filter((barcodeId) => barcodeId !== contact.barcodeId) : [...selectedGuarantors, contact.barcodeId])}><Text style={{ ...styles.text, color: selected ? '#216E4E' : undefined }}>{selected ? '✅ ' : '◻️ '}{contact.alias} ({contact.displayName ?? contact.barcodeId})</Text></Pressable>;
        })}
        <Pressable onPress={() => void submitLoan()} style={styles.button}><Text style={styles.buttonText}>ارسال درخواست</Text></Pressable>
        {error ? <Text style={styles.danger}>{error}</Text> : null}
      </View>
      {(loans.data?.items ?? []).map((loan) => (
        <View key={loan.id} style={styles.card}>
          <Text style={styles.heading}>وام {formatCoupons(loan.principalCoupons)} کوپن</Text>
          <Text style={styles.text}>وضعیت: {loan.status} · بدهی: {formatCoupons(loan.outstandingCoupons)}</Text>
          {loan.guarantees.map((guarantee) => (
            <View key={guarantee.id} style={{ gap: 8 }}>
              <Text style={styles.muted}>ضمانت: {formatCoupons(guarantee.amountCoupons)} · {guarantee.status}</Text>
              <TextInput value={codes[guarantee.id] ?? ''} onChangeText={(value) => setCodes((current) => ({ ...current, [guarantee.id]: value.replace(/\D/g, '').slice(0, 4) }))} placeholder="کد ضمانت" style={styles.input} keyboardType="number-pad" />
              {guarantee.guarantorId === member?.id ? <>
                <TextInput value={pins[guarantee.id] ?? ''} onChangeText={(value) => setPins((current) => ({ ...current, [guarantee.id]: value.replace(/\D/g, '').slice(0, 4) }))} placeholder={fa.pin} style={styles.input} keyboardType="number-pad" secureTextEntry />
                <Pressable onPress={() => void approve(guarantee.id)} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>تأیید ضمانت</Text></Pressable>
              </> : null}
              {loan.borrowerId === member?.id ? <Pressable onPress={() => void activate(guarantee.id)} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>فعال‌سازی ضمانت</Text></Pressable> : null}
            </View>
          ))}
          {loan.outstandingCoupons !== '0' && loan.borrowerId ? <Pressable onPress={() => void repay(loan.id, loan.outstandingCoupons)} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>پرداخت بدهی</Text></Pressable> : null}
          <Text style={styles.muted}>{formatDate(loan.createdAt)}</Text>
        </View>
      ))}
      <View style={styles.card}><Text style={styles.heading}>خیریه</Text><Text style={styles.muted}>{fa.charityNotBuilt}</Text></View>
    </Page>
  );
}
