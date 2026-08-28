import React, { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { request } from '../src/api/client';
import type { BarcodeDetail, BarcodeResult } from '../src/api/types';
import { Page } from '../src/components/Screen';
import { useTranslation } from '../src/i18n';
import { styles } from '../src/styles';

export default function Barcodes() {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<BarcodeResult[]>([]);
  const [selected, setSelected] = useState<BarcodeDetail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (query.trim().length < 3) {
      setItems([]);
      setError('');
      return;
    }
    let active = true;
    void request<{ items: BarcodeResult[] }>(`/v1/me/barcodes?query=${encodeURIComponent(query)}&limit=20`)
      .then((result) => { if (active) setItems(result.items); })
      .catch(() => { if (active) setError(t.unknownError); });
    return () => { active = false; };
  }, [query]);

  const openDetail = async (barcodeId: string) => {
    setError('');
    try {
      setSelected(await request<BarcodeDetail>(`/v1/me/barcodes/${encodeURIComponent(barcodeId)}`));
    } catch {
      setError(t.unknownError);
    }
  };

  return (
    <Page>
      <Text style={styles.title}>{t.barcodeSearch}</Text>
      <TextInput value={query} onChangeText={setQuery} placeholder={t.barcode} style={styles.input} />
      {items.length === 0 ? <Text style={styles.muted}>{t.noBarcodeResults}</Text> : items.map((item) => (
        <Pressable key={item.barcodeId} onPress={() => void openDetail(item.barcodeId)} style={styles.card}>
          <Text style={styles.heading}>{item.displayName ?? item.barcodeId}</Text>
          <Text style={styles.muted}>{item.barcodeId}</Text>
        </Pressable>
      ))}
      {selected ? (
        <View style={styles.card}>
          <Text style={styles.heading}>{t.barcodeDetail}</Text>
          <Text style={styles.text}>{selected.displayName ?? selected.barcodeId}</Text>
          <Text style={styles.muted}>{selected.barcodeId}</Text>
          <Text style={styles.muted}>{selected.kycStatus}</Text>
          {selected.isDemo ? <Text style={styles.demoLabel}>{t.demoTestdata}</Text> : null}
        </View>
      ) : null}
      {error ? <Text style={styles.danger}>{error}</Text> : null}
    </Page>
  );
}
