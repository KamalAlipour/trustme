import React, { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ApiError, request } from '../src/api/client';
import { useContacts, useInvalidateMoney } from '../src/hooks';
import { Page } from '../src/components/Screen';
import { fa } from '../src/i18n/fa';
import { styles } from '../src/styles';

export default function Contacts() {
  const [query, setQuery] = useState('');
  const [alias, setAlias] = useState('');
  const [barcodeId, setBarcodeId] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [sort, setSort] = useState<'alias' | 'recent'>('alias');
  const [error, setError] = useState('');
  const params = useLocalSearchParams<{ barcodeId?: string }>();
  useEffect(() => {
    if (params.barcodeId !== undefined) setBarcodeId(params.barcodeId);
  }, [params.barcodeId]);
  const contacts = useContacts(query, sort);
  const invalidate = useInvalidateMoney();
  const add = async () => {
    try { await request('/v1/me/contacts', { method: 'POST', body: { barcodeId, alias } }); setAlias(''); setBarcodeId(''); await invalidate(); } catch (cause) { setError(cause instanceof ApiError ? cause.message : fa.unknownError); }
  };
  return (
    <Page>
      <View style={styles.row}><Text style={styles.title}>{fa.contacts}</Text><Pressable onPress={() => router.back()}><Text style={styles.secondaryButtonText}>بستن</Text></Pressable></View>
      <TextInput value={query} onChangeText={setQuery} placeholder="جستجو" style={styles.input} />
      <Pressable onPress={() => setSort(sort === 'alias' ? 'recent' : 'alias')} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{sort === 'alias' ? 'مرتب‌سازی بر اساس فعالیت' : 'مرتب‌سازی بر اساس نام'}</Text></Pressable>
      {(contacts.data?.items ?? []).map((contact) => <View key={contact.id} style={styles.card}>
        {editingId === contact.id ? <TextInput value={alias} onChangeText={setAlias} style={styles.input} /> : <Text style={styles.heading}>{contact.alias}</Text>}
        <Text style={styles.muted}>{contact.displayName ?? 'نام ثبت نشده'} · {contact.barcodeId}</Text>
        <View style={styles.row}>
          <Pressable onPress={() => {
            if (editingId === contact.id) {
              void request(`/v1/me/contacts/${contact.id}`, { method: 'PATCH', body: { alias } }).then(async () => { setEditingId(null); setAlias(''); await invalidate(); });
            } else {
              setEditingId(contact.id);
              setAlias(contact.alias);
            }
          }}><Text style={styles.secondaryButtonText}>{editingId === contact.id ? fa.save : 'تغییر نام'}</Text></Pressable>
          <Pressable onPress={() => void request(`/v1/me/contacts/${contact.id}`, { method: 'DELETE' }).then(invalidate)}><Text style={styles.danger}>حذف</Text></Pressable>
        </View>
      </View>)}
      <View style={styles.card}>
        <Text style={styles.heading}>افزودن مخاطب</Text>
        <TextInput value={barcodeId} onChangeText={setBarcodeId} placeholder={fa.barcode} style={styles.input} />
        <TextInput value={alias} onChangeText={setAlias} placeholder={fa.alias} style={styles.input} />
        <Pressable onPress={() => router.push({ pathname: '/scan', params: { returnTo: '/contacts' } })} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>اسکن QR</Text></Pressable>
        <Pressable onPress={() => void add()} style={styles.button}><Text style={styles.buttonText}>{fa.save}</Text></Pressable>
        {error ? <Text style={styles.danger}>{error}</Text> : null}
      </View>
    </Page>
  );
}
