import React from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useInfiniteQuery } from '@tanstack/react-query';
import { request } from '../../src/api/client';
import type { TransactionsPage } from '../../src/api/types';
import { Page, LoadingScreen, ErrorMessage } from '../../src/components/Screen';
import { formatCoupons, formatDate } from '../../src/lib/pin';
import { fa } from '../../src/i18n/fa';
import { styles } from '../../src/styles';

export default function Purchases() {
  const [search, setSearch] = React.useState('');
  const [incomingFirst, setIncomingFirst] = React.useState(false);
  const transactions = useInfiniteQuery({
    queryKey: ['transactions'],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) => request<TransactionsPage>(`/v1/me/transactions?limit=25${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  if (transactions.isLoading) return <LoadingScreen />;
  if (transactions.error) return <Page><ErrorMessage message={(transactions.error as Error).message} onRetry={() => void transactions.refetch()} /></Page>;
  const items = (transactions.data?.pages.flatMap((page) => page.items) ?? [])
    .filter((item) => `${item.counterparty.displayName ?? ''} ${item.counterparty.barcodeId ?? ''}`.toLowerCase().includes(search.toLowerCase()))
    .sort((left, right) => incomingFirst ? Number(right.direction === 'in') - Number(left.direction === 'in') : 0);
  return (
    <Page>
      <Text style={styles.title}>{fa.purchases}</Text>
      <TextInput value={search} onChangeText={setSearch} placeholder="جستجوی طرف مقابل" style={styles.input} />
      <Pressable onPress={() => setIncomingFirst(!incomingFirst)} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{incomingFirst ? 'ابتدا دریافتی' : 'مرتب‌سازی جهت'}</Text></Pressable>
      {items.length === 0 ? <Text style={styles.muted}>هنوز تراکنشی ثبت نشده است.</Text> : items.map((item) => (
        <View key={item.id} style={styles.card}>
          <View style={styles.row}>
            <Text style={{ ...styles.heading, color: item.direction === 'in' ? '#216E4E' : '#B3261E' }}>{item.direction === 'in' ? '+' : '-'}{formatCoupons(item.amountCoupons)}</Text>
            <Text style={styles.text}>{item.counterparty.displayName ?? item.counterparty.barcodeId ?? item.counterparty.systemAccountType ?? 'سیستم'}</Text>
          </View>
          <Text style={styles.muted}>{formatDate(item.transaction.createdAt)} · {item.transaction.status}</Text>
          <Pressable onPress={() => undefined}><Text style={styles.muted}>{fa.refundNotBuilt}</Text></Pressable>
        </View>
      ))}
      {transactions.hasNextPage ? <Pressable onPress={() => void transactions.fetchNextPage()} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>تراکنش‌های بیشتر</Text></Pressable> : null}
    </Page>
  );
}
