import React from 'react';
import { Pressable, Text, TextInput, TextStyle, View } from 'react-native';
import { request } from '../api/client';
import { useAidRequests, useCharities, useCharityRequests, useInvalidateMoney, useLoans } from '../hooks';
import { useSession } from '../auth/session';
import { EvidencePicker } from './EvidencePicker';
import type { AidRequest } from '../api/types';
import { mapApiError } from '../lib/errors';
import { formatCoupons, formatDate } from '../lib/format';
import { approvedAmountWithinRequest } from '../lib/coupons';
import { useTranslation } from '../i18n';
import { styles } from '../styles';
import { EvidenceViewer } from './EvidenceViewer';

function statusLabel(status: string, t: ReturnType<typeof useTranslation>['t']): { label: string; style: TextStyle } {
  if (status === 'APPROVED') return { label: `🟢 ${t.aidApproved}`, style: styles.notice };
  if (status === 'REJECTED') return { label: `🔴 ${t.aidRejected}`, style: styles.danger };
  if (status === 'DOCUMENTS_REQUESTED') return { label: `📑 ${t.documentsRequested}`, style: styles.muted };
  return { label: `🟡 ${t.aidPending}`, style: styles.muted };
}

export function CharitySection() {
  const { t, language } = useTranslation();
  const charities = useCharities();
  const aid = useAidRequests();
  const agent = useCharityRequests();
  const loans = useLoans();
  const invalidate = useInvalidateMoney();
  const { getStepUpPin, member } = useSession();
  const [charityId, setCharityId] = React.useState('');
  const [amount, setAmount] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [loanId, setLoanId] = React.useState<string | undefined>();
  const [mediaIds, setMediaIds] = React.useState<string[]>([]);
  const [error, setError] = React.useState('');
  const [notes, setNotes] = React.useState<Record<string, string>>({});
  const [approved, setApproved] = React.useState<Record<string, string>>({});

  const submit = async () => {
    setError('');
    if (charityId === '' || !/^[1-9]\d*$/.test(amount) || description.trim() === '') { setError(t.charityFormIncomplete); return; }
    const openForCharity = (aid.data?.items ?? []).filter((item) => item.charityId === charityId && (item.status === 'PENDING' || item.status === 'DOCUMENTS_REQUESTED')).length;
    if (openForCharity >= 3) { setError(t.charityLimit); return; }
    try {
      await request('/v1/me/aid-requests', { method: 'POST', body: { charityId, amountCoupons: amount, description: description.trim(), ...(loanId === undefined ? {} : { loanId }), mediaIds } });
      setAmount(''); setDescription(''); setMediaIds([]); await invalidate();
    } catch (cause) { setError(mapApiError(cause, t)); }
  };
  const sendDocuments = async (requestId: string, documentMediaIds: string[]): Promise<boolean> => {
    try { await request(`/v1/me/aid-requests/${requestId}/documents`, { method: 'POST', body: { mediaIds: documentMediaIds } }); await invalidate(); return true; } catch (cause) { setError(mapApiError(cause, t)); return false; }
  };
  const review = async (item: AidRequest, action: 'approve' | 'reject' | 'request-documents') => {
    setError('');
    try {
      if (action === 'approve') {
        const pin = await getStepUpPin();
        if (!pin) { setError(t.operationPinRequired); return; }
        const value = approved[item.id] ?? item.amountCoupons;
        if (!approvedAmountWithinRequest(value, item.amountCoupons)) { setError(t.approvedAmountTooHigh); return; }
        await request(`/v1/me/charity-requests/${item.id}/approve`, { method: 'POST', body: { approvedCoupons: value, pin, ...(notes[item.id] ? { note: notes[item.id] } : {}) } });
      } else {
        const note = notes[item.id]?.trim();
        if (!note) { setError(t.decisionNoteRequired); return; }
        await request(`/v1/me/charity-requests/${item.id}/${action}`, { method: 'POST', body: { note } });
      }
      await invalidate();
    } catch (cause) { setError(mapApiError(cause, t)); }
  };

    return <View style={styles.card}>
    <Text style={styles.heading}>{t.charities}</Text>
    {(charities.data?.items ?? []).map((charity) => <Pressable key={charity.id} onPress={() => setCharityId(charity.id)}><Text style={{ ...styles.text, color: charity.id === charityId ? '#216E4E' : undefined }}>{charity.id === charityId ? '✅ ' : '◻️ '}{charity.name}</Text>{charity.description ? <Text style={styles.muted}>{charity.description}</Text> : null}</Pressable>)}
    <Text style={styles.heading}>{t.aidRequest}</Text>
    <TextInput value={amount} onChangeText={(value) => setAmount(value.replace(/\D/g, ''))} placeholder={t.amount} style={styles.input} keyboardType="number-pad" />
    <TextInput value={description} onChangeText={setDescription} placeholder={t.charityDescription} style={styles.input} multiline />
    {(loans.data?.items ?? []).filter((loan) => loan.borrowerId === member?.id && loan.outstandingCoupons !== '0').map((loan) => <Pressable key={loan.id} onPress={() => setLoanId(loanId === loan.id ? undefined : loan.id)}><Text style={styles.text}>{loanId === loan.id ? '✅ ' : '◻️ '}{t.charityLoan(formatCoupons(loan.outstandingCoupons, language))}</Text></Pressable>)}
    <EvidencePicker mediaIds={mediaIds} onChange={setMediaIds} />
    <Pressable onPress={() => void submit()} style={styles.button}><Text style={styles.buttonText}>{t.aidRequest}</Text></Pressable>
    {(aid.data?.items ?? []).map((item) => <AidRow key={item.id} item={item} onDocuments={(ids) => sendDocuments(item.id, ids)} />)}
    {(agent.data?.items ?? []).length > 0 ? <><Text style={styles.heading}>{t.socialWorkerRequests}</Text>{(agent.data?.items ?? []).map((item) => <View key={item.id} style={styles.card}>
      <Text style={styles.heading}>{item.applicant?.displayName ?? item.applicant?.barcodeId}</Text><Text style={styles.text}>{t.couponBalance(formatCoupons(item.amountCoupons, language))} · {item.description}</Text><EvidenceViewer ids={item.mediaIds} />
      <Text style={statusLabel(item.status, t).style}>{statusLabel(item.status, t).label}</Text>
      {item.status === 'PENDING' ? <><TextInput value={approved[item.id] ?? item.amountCoupons} onChangeText={(value) => setApproved((current) => ({ ...current, [item.id]: value.replace(/\D/g, '') }))} style={styles.input} keyboardType="number-pad" /><TextInput value={notes[item.id] ?? ''} onChangeText={(value) => setNotes((current) => ({ ...current, [item.id]: value }))} placeholder={t.decisionNote} style={styles.input} /><View style={styles.row}><Pressable onPress={() => void review(item, 'approve')} style={styles.button}><Text style={styles.buttonText}>{t.approveAndPay}</Text></Pressable><Pressable onPress={() => void review(item, 'reject')} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.reject}</Text></Pressable></View><Pressable onPress={() => void review(item, 'request-documents')} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.requestDocuments}</Text></Pressable></> : null}
    </View>)}</> : null}
    {error ? <Text style={styles.danger}>{error}</Text> : null}
  </View>;
}

function AidRow({ item, onDocuments }: { item: AidRequest; onDocuments: (ids: string[]) => Promise<boolean> }) {
  const { t, language } = useTranslation();
  const [mediaIds, setMediaIds] = React.useState<string[]>([]);
  const status = statusLabel(item.status, t);
  return <View style={styles.card}><Text style={styles.text}>{item.charityName ?? item.charityId} · {t.couponBalance(formatCoupons(item.amountCoupons, language))}</Text><Text style={styles.text}>{item.description}</Text><Text style={status.style}>{status.label}</Text>{item.approvedCoupons ? <Text style={styles.notice}>{t.paidAmount}: {formatCoupons(item.approvedCoupons, language)}</Text> : null}{item.decisionNote ? <Text style={styles.muted}>{item.decisionNote}</Text> : null}<Text style={styles.muted}>{formatDate(item.createdAt, language)}</Text><EvidenceViewer ids={item.mediaIds} />{item.status === 'DOCUMENTS_REQUESTED' ? <><EvidencePicker mediaIds={mediaIds} onChange={setMediaIds} /><Pressable onPress={() => void (async () => { if (await onDocuments(mediaIds)) setMediaIds([]); })()} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.sendDocuments}</Text></Pressable></> : null}</View>;
}
