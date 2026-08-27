import React from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useInfiniteQuery } from '@tanstack/react-query';
import { request } from '../../src/api/client';
import type { TransactionsPage } from '../../src/api/types';
import { Page, LoadingScreen, ErrorMessage } from '../../src/components/Screen';
import { formatCoupons, formatDate } from '../../src/lib/format';
import { fa } from '../../src/i18n/fa';
import { styles } from '../../src/styles';
import { RefundSheet } from '../../src/components/RefundSheet';
import { SellerRefundPanel } from '../../src/components/SellerRefundPanel';
import { canRequestRefund } from '../../src/lib/refunds';

export default function Purchases() {
  const [search, setSearch] = React.useState('');
  const [sort, setSort] = React.useState<'direction' | 'date-desc' | 'date-asc' | 'amount-desc' | 'amount-asc'>('date-desc');
  const [refundItem, setRefundItem] = React.useState<{ id: string; amount: string } | null>(null);
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
    .sort((left, right) => {
      if (left.refund?.status === 'PENDING' && right.refund?.status !== 'PENDING') return -1;
      if (right.refund?.status === 'PENDING' && left.refund?.status !== 'PENDING') return 1;
      if (sort === 'direction') return Number(right.direction === 'in') - Number(left.direction === 'in');
      if (sort === 'date-desc' || sort === 'date-asc') {
        const difference = new Date(right.transaction.createdAt).getTime() - new Date(left.transaction.createdAt).getTime();
        return sort === 'date-desc' ? difference : -difference;
      }
      const difference = compareCoupons(right.amountCoupons, left.amountCoupons);
      return sort === 'amount-desc' ? difference : -difference;
    });
  const nextSort = { direction: 'date-desc', 'date-desc': 'date-asc', 'date-asc': 'amount-desc', 'amount-desc': 'amount-asc', 'amount-asc': 'direction' } as const;
  const sortLabel = { direction: 'مرتب‌سازی جهت', 'date-desc': 'جدیدترین ابتدا', 'date-asc': 'قدیمی‌ترین ابتدا', 'amount-desc': 'بیشترین مبلغ ابتدا', 'amount-asc': 'کمترین مبلغ ابتدا' }[sort];
  return (
    <Page>
      <Text style={styles.title}>{fa.purchases}</Text>
      <SellerRefundPanel />
      <TextInput value={search} onChangeText={setSearch} placeholder="جستجوی طرف مقابل" style={styles.input} />
      <Text style={styles.muted}>جستجو فقط در تاریخچه بارگذاری‌شده انجام می‌شود.</Text>
      <Pressable onPress={() => setSort(nextSort[sort])} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{sortLabel}</Text></Pressable>
      {items.length === 0 ? <Text style={styles.muted}>هنوز تراکنشی ثبت نشده است.</Text> : items.map((item) => (
        <View key={item.id} style={styles.card}>
          <View style={styles.row}>
            <Text style={{ ...styles.heading, color: item.direction === 'in' ? '#216E4E' : '#B3261E' }}>{item.direction === 'in' ? '+' : '-'}{formatCoupons(item.amountCoupons)}</Text>
            <Text style={styles.text}>{item.counterparty.displayName ?? item.counterparty.barcodeId ?? item.counterparty.systemAccountType ?? 'سیستم'}</Text>
          </View>
          <Text style={styles.muted}>{formatDate(item.transaction.createdAt)} · {item.transaction.status}</Text>
          {item.refund?.status === 'PENDING' ? <Text style={styles.muted}>🟡 {fa.refundPending}</Text> : null}
          {item.refund?.status === 'APPROVED' ? <Text style={styles.notice}>🟢 {fa.refundApproved}</Text> : null}
          {item.refund?.status === 'REJECTED' ? <Text style={styles.danger}>🔴 {fa.refundRejected}</Text> : null}
          {canRequestRefund(item)
            ? <Pressable onPress={() => item.refundableTransactionId === null ? undefined : setRefundItem({ id: item.refundableTransactionId, amount: item.amountCoupons })} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{fa.requestRefund}</Text></Pressable>
            : null}
          {item.refundableTransactionId !== null && item.direction === 'out' && item.refund !== null && item.refund.status !== 'PENDING' && hasRefundRemainder(item.refund.amountCoupons, item.amountCoupons)
            ? <Text style={styles.muted}>{fa.requestAnotherRefund}</Text>
            : null}
        </View>
      ))}
      {transactions.hasNextPage ? <Pressable onPress={() => void transactions.fetchNextPage()} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>تراکنش‌های بیشتر</Text></Pressable> : null}
      {refundItem ? <RefundSheet transactionId={refundItem.id} purchaseAmount={refundItem.amount} onClose={() => setRefundItem(null)} /> : null}
    </Page>
  );
}

function compareCoupons(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/, '');
  const normalizedRight = right.replace(/^0+(?=\d)/, '');
  if (normalizedLeft.length !== normalizedRight.length) return normalizedLeft.length - normalizedRight.length;
  return normalizedLeft === normalizedRight ? 0 : normalizedLeft > normalizedRight ? 1 : -1;
}

function hasRefundRemainder(refunded: string, purchase: string): boolean {
  try { return BigInt(refunded) < BigInt(purchase); } catch { return false; }
}
