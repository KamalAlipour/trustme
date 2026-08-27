import React from 'react';
import { Pressable, Text, TextInput, TextStyle, View } from 'react-native';
import * as FileSystem from 'expo-file-system';
import { API_BASE_URL, getAccessToken, request } from '../api/client';
import { useAidRequests, useCharities, useCharityRequests, useInvalidateMoney, useLoans } from '../hooks';
import { useSession } from '../auth/session';
import { EvidencePicker } from './EvidencePicker';
import type { AidRequest } from '../api/types';
import { mapApiError } from '../lib/errors';
import { formatCoupons, formatDate } from '../lib/format';
import { approvedAmountWithinRequest } from '../lib/coupons';
import { fa } from '../i18n/fa';
import { styles } from '../styles';

function statusLabel(status: string): { label: string; style: TextStyle } {
  if (status === 'APPROVED') return { label: `🟢 ${fa.aidApproved}`, style: styles.notice };
  if (status === 'REJECTED') return { label: `🔴 ${fa.aidRejected}`, style: styles.danger };
  if (status === 'DOCUMENTS_REQUESTED') return { label: `📑 ${fa.documentsRequested}`, style: styles.muted };
  return { label: `🟡 ${fa.aidPending}`, style: styles.muted };
}

async function openEvidence(id: string): Promise<void> {
  const directory = FileSystem.cacheDirectory;
  const token = getAccessToken();
  if (directory === null || token === null) return;
  await FileSystem.downloadAsync(`${API_BASE_URL}/v1/me/media/${encodeURIComponent(id)}`, `${directory}evidence-${id}`, { headers: { authorization: `Bearer ${token}` } });
}

function EvidenceChips({ ids }: { ids: string[] }) {
  return <View style={styles.row}>{ids.map((id) => <Pressable key={id} onPress={() => void openEvidence(id)}><Text style={styles.secondaryButtonText}>📎 {id.slice(0, 8)}</Text></Pressable>)}</View>;
}

export function CharitySection() {
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
    if (charityId === '' || !/^[1-9]\d*$/.test(amount) || description.trim() === '') { setError('خیریه، مبلغ و توضیحات را کامل کنید.'); return; }
    const openForCharity = (aid.data?.items ?? []).filter((item) => item.charityId === charityId && (item.status === 'PENDING' || item.status === 'DOCUMENTS_REQUESTED')).length;
    if (openForCharity >= 3) { setError('برای هر خیریه حداکثر سه درخواست باز می‌توانید داشته باشید. ابتدا یکی از درخواست‌های قبلی را تکمیل کنید.'); return; }
    try {
      await request('/v1/me/aid-requests', { method: 'POST', body: { charityId, amountCoupons: amount, description: description.trim(), ...(loanId === undefined ? {} : { loanId }), mediaIds } });
      setAmount(''); setDescription(''); setMediaIds([]); await invalidate();
    } catch (cause) { setError(mapApiError(cause)); }
  };
  const sendDocuments = async (requestId: string) => {
    try { await request(`/v1/me/aid-requests/${requestId}/documents`, { method: 'POST', body: { mediaIds } }); setMediaIds([]); await invalidate(); } catch (cause) { setError(mapApiError(cause)); }
  };
  const review = async (item: AidRequest, action: 'approve' | 'reject' | 'request-documents') => {
    setError('');
    try {
      if (action === 'approve') {
        const pin = await getStepUpPin();
        if (!pin) { setError('رمز برای این عملیات لازم است.'); return; }
        const value = approved[item.id] ?? item.amountCoupons;
        if (!approvedAmountWithinRequest(value, item.amountCoupons)) { setError('مبلغ تأییدشده نمی‌تواند بیشتر از مبلغ درخواستی باشد.'); return; }
        await request(`/v1/me/charity-requests/${item.id}/approve`, { method: 'POST', body: { approvedCoupons: value, pin, ...(notes[item.id] ? { note: notes[item.id] } : {}) } });
      } else {
        const note = notes[item.id]?.trim();
        if (!note) { setError('یادداشت تصمیم را وارد کنید.'); return; }
        await request(`/v1/me/charity-requests/${item.id}/${action}`, { method: 'POST', body: { note } });
      }
      await invalidate();
    } catch (cause) { setError(mapApiError(cause)); }
  };

    return <View style={styles.card}>
    <Text style={styles.heading}>{fa.charities}</Text>
    {(charities.data?.items ?? []).map((charity) => <Pressable key={charity.id} onPress={() => setCharityId(charity.id)}><Text style={{ ...styles.text, color: charity.id === charityId ? '#216E4E' : undefined }}>{charity.id === charityId ? '✅ ' : '◻️ '}{charity.name}</Text>{charity.description ? <Text style={styles.muted}>{charity.description}</Text> : null}</Pressable>)}
    <Text style={styles.heading}>{fa.aidRequest}</Text>
    <TextInput value={amount} onChangeText={(value) => setAmount(value.replace(/\D/g, ''))} placeholder={fa.amount} style={styles.input} keyboardType="number-pad" />
    <TextInput value={description} onChangeText={setDescription} placeholder={fa.charityDescription} style={styles.input} multiline />
    {(loans.data?.items ?? []).filter((loan) => loan.borrowerId === member?.id && loan.outstandingCoupons !== '0').map((loan) => <Pressable key={loan.id} onPress={() => setLoanId(loanId === loan.id ? undefined : loan.id)}><Text style={styles.text}>{loanId === loan.id ? '✅ ' : '◻️ '}وام {formatCoupons(loan.outstandingCoupons)}</Text></Pressable>)}
    <EvidencePicker mediaIds={mediaIds} onChange={setMediaIds} />
    <Pressable onPress={() => void submit()} style={styles.button}><Text style={styles.buttonText}>{fa.aidRequest}</Text></Pressable>
    {(aid.data?.items ?? []).map((item) => <AidRow key={item.id} item={item} onDocuments={() => void sendDocuments(item.id)} mediaIds={mediaIds} setMediaIds={setMediaIds} />)}
    {(agent.data?.items ?? []).length > 0 ? <><Text style={styles.heading}>درخواست‌های مددکاری</Text>{(agent.data?.items ?? []).map((item) => <View key={item.id} style={styles.card}>
      <Text style={styles.heading}>{item.applicant?.displayName ?? item.applicant?.barcodeId}</Text><Text style={styles.text}>{formatCoupons(item.amountCoupons)} کوپن · {item.description}</Text><EvidenceChips ids={item.mediaIds} />
      <Text style={statusLabel(item.status).style}>{statusLabel(item.status).label}</Text>
      {item.status === 'PENDING' ? <><TextInput value={approved[item.id] ?? item.amountCoupons} onChangeText={(value) => setApproved((current) => ({ ...current, [item.id]: value.replace(/\D/g, '') }))} style={styles.input} keyboardType="number-pad" /><TextInput value={notes[item.id] ?? ''} onChangeText={(value) => setNotes((current) => ({ ...current, [item.id]: value }))} placeholder={fa.decisionNote} style={styles.input} /><View style={styles.row}><Pressable onPress={() => void review(item, 'approve')} style={styles.button}><Text style={styles.buttonText}>{fa.approveAndPay}</Text></Pressable><Pressable onPress={() => void review(item, 'reject')} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{fa.reject}</Text></Pressable></View><Pressable onPress={() => void review(item, 'request-documents')} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{fa.requestDocuments}</Text></Pressable></> : null}
    </View>)}</> : null}
    {error ? <Text style={styles.danger}>{error}</Text> : null}
  </View>;
}

function AidRow({ item, onDocuments, mediaIds, setMediaIds }: { item: AidRequest; onDocuments: () => void; mediaIds: string[]; setMediaIds: (ids: string[]) => void }) {
  const status = statusLabel(item.status);
  return <View style={styles.card}><Text style={styles.text}>{item.charityName ?? item.charityId} · {formatCoupons(item.amountCoupons)} کوپن</Text><Text style={styles.text}>{item.description}</Text><Text style={status.style}>{status.label}</Text>{item.approvedCoupons ? <Text style={styles.notice}>مبلغ پرداختی: {formatCoupons(item.approvedCoupons)}</Text> : null}{item.decisionNote ? <Text style={styles.muted}>{item.decisionNote}</Text> : null}<Text style={styles.muted}>{formatDate(item.createdAt)}</Text><EvidenceChips ids={item.mediaIds} />{item.status === 'DOCUMENTS_REQUESTED' ? <><EvidencePicker mediaIds={mediaIds} onChange={setMediaIds} /><Pressable onPress={onDocuments} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{fa.sendDocuments}</Text></Pressable></> : null}</View>;
}
