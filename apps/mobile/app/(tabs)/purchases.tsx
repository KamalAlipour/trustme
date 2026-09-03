import React from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useInfiniteQuery } from '@tanstack/react-query';
import { request } from '../../src/api/client';
import type { TransactionsPage } from '../../src/api/types';
import { Page, LoadingScreen, ErrorMessage } from '../../src/components/Screen';
import { formatCoupons, formatDate } from '../../src/lib/format';
import { useTranslation } from '../../src/i18n';
import { colors, styles } from '../../src/styles';
import { RefundSheet } from '../../src/components/RefundSheet';
import { SellerRefundPanel } from '../../src/components/SellerRefundPanel';
import { canRequestRefund, refundableRemainder } from '../../src/lib/refunds';
import { HeaderIcons } from '../../src/components/HeaderIcons';

export default function Purchases() {
  const { t, language } = useTranslation();
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
  const sortLabel = { direction: t.sortDirection, 'date-desc': t.newestFirst, 'date-asc': t.oldestFirst, 'amount-desc': t.highestAmountFirst, 'amount-asc': t.lowestAmountFirst }[sort];
  const sortIcon: 'arrow-up' | 'arrow-down' = sort === 'date-asc' || sort === 'amount-asc' ? 'arrow-up' : 'arrow-down';
  return (
    <Page>
      <View style={styles.row}><Text style={styles.title}>{t.purchases}</Text><HeaderIcons /></View>
      <SellerRefundPanel />
      <TextInput value={search} onChangeText={setSearch} placeholder={t.searchCounterparty} style={styles.input} />
      <Text style={styles.muted}>{t.loadedHistoryOnly}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={sortLabel}
        onPress={() => setSort(nextSort[sort])}
        style={{ ...styles.row, justifyContent: 'space-between', paddingVertical: 8 }}
      >
        <Text style={styles.heading}>{t.transactions}</Text>
        <View style={styles.row}>
          <Text style={styles.muted}>{sortLabel}</Text>
          <Ionicons name={sortIcon} size={24} color={colors.primary} />
        </View>
      </Pressable>
      {items.length === 0 ? <Text style={styles.muted}>{t.noTransactions}</Text> : items.map((item) => (
        <View key={item.id} style={styles.card}>
          <View style={styles.row}>
            <Text style={{ ...styles.heading, color: item.direction === 'in' ? '#216E4E' : '#B3261E' }}>{item.direction === 'in' ? '+' : '-'}{formatCoupons(item.amountCoupons, language)}</Text>
            <Text style={styles.text}>{item.counterparty.displayName ?? item.counterparty.barcodeId ?? item.counterparty.systemAccountType ?? t.system}</Text>
          </View>
          <Text style={styles.muted}>{formatDate(item.transaction.createdAt, language)} · {item.transaction.status}</Text>
          {item.refund?.status === 'PENDING' ? <Text style={styles.muted}>🟡 {t.refundPending}</Text> : null}
          {item.refund?.status === 'APPROVED' ? <Text style={styles.notice}>🟢 {t.refundApproved}</Text> : null}
          {item.refund?.status === 'REJECTED' ? <Text style={styles.danger}>🔴 {t.refundRejected}</Text> : null}
          {canRequestRefund(item)
            ? <Pressable onPress={() => item.refundableTransactionId === null ? undefined : setRefundItem({ id: item.refundableTransactionId, amount: refundableRemainder(item) })} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{item.refund === null ? t.requestRefund : t.requestAnotherRefund}</Text></Pressable>
            : null}
        </View>
      ))}
      {transactions.hasNextPage ? <Pressable onPress={() => void transactions.fetchNextPage()} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.moreTransactions}</Text></Pressable> : null}
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
