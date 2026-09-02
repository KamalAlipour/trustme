import React, { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ApiError, request } from '../src/api/client';
import { useContacts, useInvalidateMoney } from '../src/hooks';
import { Page } from '../src/components/Screen';
import { useTranslation } from '../src/i18n';
import { styles } from '../src/styles';

export default function Contacts() {
  const { t } = useTranslation();
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
    try { await request('/v1/me/contacts', { method: 'POST', body: { barcodeId, alias } }); setAlias(''); setBarcodeId(''); await invalidate(); } catch (cause) { setError(cause instanceof ApiError ? cause.message : t.unknownError); }
  };
  return (
    <Page>
      <View style={styles.row}><Text style={styles.title}>{t.contacts}</Text><Pressable onPress={() => router.back()}><Text style={styles.secondaryButtonText}>{t.closeButton}</Text></Pressable></View>
      <TextInput value={query} onChangeText={setQuery} placeholder={t.search} style={styles.input} />
      <Pressable onPress={() => setSort(sort === 'alias' ? 'recent' : 'alias')} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{sort === 'alias' ? t.sortByActivity : t.sortByName}</Text></Pressable>
      {(contacts.data?.items ?? []).map((contact) => <View key={contact.id} style={styles.card}>
        {editingId === contact.id ? <TextInput value={alias} onChangeText={setAlias} style={styles.input} /> : <Text style={styles.heading}>{contact.alias}</Text>}
        <Text style={styles.muted}>{contact.displayName ?? t.nameNotSet} · {contact.barcodeId}</Text>
        <View style={styles.row}>
          <Pressable onPress={() => {
            if (editingId === contact.id) {
              void request(`/v1/me/contacts/${contact.id}`, { method: 'PATCH', body: { alias } }).then(async () => { setEditingId(null); setAlias(''); await invalidate(); });
            } else {
              setEditingId(contact.id);
              setAlias(contact.alias);
            }
          }}><Text style={styles.secondaryButtonText}>{editingId === contact.id ? t.save : t.rename}</Text></Pressable>
          <Pressable onPress={() => void request(`/v1/me/contacts/${contact.id}`, { method: 'DELETE' }).then(invalidate)}><Text style={styles.danger}>{t.delete}</Text></Pressable>
        </View>
      </View>)}
      <View style={styles.card}>
        <Text style={styles.heading}>{t.addContact}</Text>
        <TextInput value={barcodeId} onChangeText={setBarcodeId} placeholder={t.barcode} style={styles.input} />
        <TextInput value={alias} onChangeText={setAlias} placeholder={t.alias} style={styles.input} />
        <Pressable onPress={() => router.push({ pathname: '/scan', params: { returnTo: '/contacts' } })} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.scanQr}</Text></Pressable>
        <Pressable onPress={() => void add()} style={styles.button}><Text style={styles.buttonText}>{t.save}</Text></Pressable>
        {error ? <Text style={styles.danger}>{error}</Text> : null}
      </View>
      <Pressable onPress={() => router.push('/barcodes')} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.barcodeSearch}</Text></Pressable>
    </Page>
  );
}
