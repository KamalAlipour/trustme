import React from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { request, ApiError } from '../api/client';
import { useAidRequests, useCharities, useContacts, useInvalidateMoney, useLoans } from '../hooks';
import { useSession } from '../auth/session';
import { EvidencePicker } from './EvidencePicker';
import { mapApiError } from '../lib/errors';
import { formatCoupons } from '../lib/format';
import { useTranslation } from '../i18n';
import { styles } from '../styles';

export function CreditRequestForm() {
  const { t, language } = useTranslation();
  const contacts = useContacts();
  const charities = useCharities();
  const aid = useAidRequests();
  const loans = useLoans();
  const invalidate = useInvalidateMoney();
  const { member } = useSession();
  const [amount, setAmount] = React.useState('');
  const [installments, setInstallments] = React.useState([{ dueAt: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), amountCoupons: '' }]);
  const [selectedGuarantors, setSelectedGuarantors] = React.useState<string[]>([]);
  const [sourceBarcodeId, setSourceBarcodeId] = React.useState('');
  const [charityId, setCharityId] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [loanId, setLoanId] = React.useState<string | undefined>();
  const [mediaIds, setMediaIds] = React.useState<string[]>([]);
  const [error, setError] = React.useState('');
  const params = useLocalSearchParams<{ barcodeId?: string; field?: string }>();
  const hasRecipient = sourceBarcodeId.trim() !== '' || charityId !== '';

  React.useEffect(() => {
    if (params.field === 'source' && params.barcodeId !== undefined) {
      setSourceBarcodeId(params.barcodeId);
      setCharityId('');
    }
  }, [params.barcodeId, params.field]);

  const submitLoan = async () => {
    setError('');
    if (sourceBarcodeId.trim() === '') { setError(t.loanSourceRequired); return; }
    if (selectedGuarantors.length === 0) { setError(t.loanMinimumGuarantor); return; }
    if (!/^[1-9]\d*$/.test(amount)) { setError(t.loanAmountRequired); return; }
    const guaranteeCoverage = BigInt(amount) * BigInt(selectedGuarantors.length);
    if (guaranteeCoverage < BigInt(amount)) { setError(t.loanGuaranteesInsufficient); return; }
    try {
      const rows = installments.map((installment) => ({ dueAt: new Date(`${installment.dueAt}T23:59:59.000Z`).toISOString(), amountCoupons: installment.amountCoupons || amount }));
      await request('/v1/me/loans', { method: 'POST', body: { principalCoupons: amount, sourceBarcodeId: sourceBarcodeId.trim(), description: description.trim() || undefined, mediaIds, installments: rows, guarantors: selectedGuarantors.map((barcodeId) => ({ barcodeId, amountCoupons: amount })) } });
      setAmount(''); setSourceBarcodeId(''); setDescription(''); setMediaIds([]); setSelectedGuarantors([]); setInstallments([{ dueAt: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), amountCoupons: '' }]); await invalidate();
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : t.unknownError); }
  };

  const submitAid = async () => {
    setError('');
    if (charityId === '' || !/^[1-9]\d*$/.test(amount) || description.trim() === '') { setError(t.charityFormIncomplete); return; }
    const openForCharity = (aid.data?.items ?? []).filter((item) => item.charityId === charityId && (item.status === 'PENDING' || item.status === 'DOCUMENTS_REQUESTED')).length;
    if (openForCharity >= 3) { setError(t.charityLimit); return; }
    try {
      await request('/v1/me/aid-requests', { method: 'POST', body: { charityId, amountCoupons: amount, description: description.trim(), ...(loanId === undefined ? {} : { loanId }), mediaIds } });
      setAmount(''); setDescription(''); setMediaIds([]); setCharityId(''); setLoanId(undefined); await invalidate();
    } catch (cause) { setError(mapApiError(cause, t)); }
  };

  return (
    <View style={styles.card}>
      <Text style={styles.heading}>{t.creditRequest}</Text>
      <Text style={styles.muted}>{t.requestFrom}</Text>
      <TextInput value={sourceBarcodeId} onChangeText={(value) => { setSourceBarcodeId(value); setCharityId(''); }} placeholder={t.sourceBarcode} style={styles.input} />
      <Pressable onPress={() => router.push({ pathname: '/scan', params: { returnTo: '/(tabs)/lending', field: 'source' } })} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.scanQr}</Text></Pressable>
      {(charities.data?.items ?? []).map((charity) => <Pressable key={charity.id} onPress={() => { setSelectedGuarantors([]); setCharityId(charity.id); }}>
        <Text style={{ ...styles.text, color: charity.id === charityId ? '#216E4E' : undefined }}>{charity.id === charityId ? '✅ ' : '◻️ '}{charity.name}</Text>
        <Text style={styles.muted}>{t.asCharity}</Text>
        {charity.description ? <Text style={styles.muted}>{charity.description}</Text> : null}
      </Pressable>)}
      {hasRecipient ? <>
        <TextInput value={amount} onChangeText={(value) => setAmount(value.replace(/\D/g, ''))} placeholder={t.amount} style={styles.input} keyboardType="number-pad" />
        {charityId !== '' ? <>
          <TextInput value={description} onChangeText={setDescription} placeholder={t.charityDescription} style={styles.input} multiline />
          <EvidencePicker mediaIds={mediaIds} onChange={setMediaIds} />
          {(loans.data?.items ?? []).filter((loan) => loan.borrowerId === member?.id && loan.outstandingCoupons !== '0').map((loan) => <Pressable key={loan.id} onPress={() => setLoanId(loanId === loan.id ? undefined : loan.id)}><Text style={styles.text}>{loanId === loan.id ? '✅ ' : '◻️ '}{t.charityLoan(formatCoupons(loan.outstandingCoupons, language))}</Text></Pressable>)}
        </> : <>
          <TextInput value={description} onChangeText={setDescription} placeholder={t.charityDescription} style={styles.input} multiline />
          <EvidencePicker mediaIds={mediaIds} onChange={setMediaIds} />
          <Text style={styles.muted}>{t.guarantors}</Text>
          {(contacts.data?.items ?? []).map((contact) => {
            const selected = selectedGuarantors.includes(contact.barcodeId);
            return <Pressable key={`guarantor-${contact.id}`} onPress={() => setSelectedGuarantors(selected ? selectedGuarantors.filter((barcodeId) => barcodeId !== contact.barcodeId) : [...selectedGuarantors, contact.barcodeId])}>
              <Text style={{ ...styles.text, color: selected ? '#216E4E' : undefined }}>{selected ? '✅ ' : '◻️ '}{contact.alias} ({contact.displayName ?? contact.barcodeId})</Text>
              <Text style={styles.muted}>{t.asGuarantor}</Text>
            </Pressable>;
          })}
          {installments.map((installment, index) => <View key={`${index}-${installment.dueAt}`} style={{ gap: 8 }}>
            <Text style={styles.muted}>{t.installment(index)}</Text>
            <TextInput value={installment.amountCoupons} onChangeText={(value) => setInstallments((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, amountCoupons: value.replace(/\D/g, '') } : row))} placeholder={t.installmentAmount} style={styles.input} keyboardType="number-pad" />
            <TextInput value={installment.dueAt} onChangeText={(value) => setInstallments((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, dueAt: value } : row))} placeholder={t.dueDate} style={styles.input} />
          </View>)}
          <Pressable onPress={() => setInstallments([...installments, { dueAt: new Date(Date.now() + (installments.length + 1) * 30 * 86400000).toISOString().slice(0, 10), amountCoupons: '' }])} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.addInstallment}</Text></Pressable>
        </>}
        <Pressable onPress={() => void (charityId !== '' ? submitAid() : submitLoan())} style={styles.button}><Text style={styles.buttonText}>{t.submitRequest}</Text></Pressable>
      </> : null}
      {error ? <Text style={styles.danger}>{error}</Text> : null}
    </View>
  );
}
