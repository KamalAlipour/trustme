import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './api/client';
import type { AidRequest, Balance, Charity, Contact, IdentityInfo, Loan, Member, RefundRequest, TransactionsPage, WithdrawalAvailability } from './api/types';

export function useMember() { return useQuery({ queryKey: ['me'], queryFn: () => request<Member>('/v1/me') }); }
export function useBalance() { return useQuery({ queryKey: ['balance'], queryFn: () => request<Balance>('/v1/me/balance') }); }
export function useIdentity() { return useQuery({ queryKey: ['identity'], queryFn: () => request<IdentityInfo>('/v1/me/identity') }); }
export function useAvailability() { return useQuery({ queryKey: ['withdrawal-availability'], queryFn: () => request<WithdrawalAvailability>('/v1/me/withdrawal-availability') }); }
export function useContacts(query = '', sort: 'alias' | 'recent' = 'alias') { return useQuery({ queryKey: ['contacts', query, sort], queryFn: () => request<{ items: Contact[] }>(`/v1/me/contacts?query=${encodeURIComponent(query)}&sort=${sort}`) }); }
export function useLoans() { return useQuery({ queryKey: ['loans'], queryFn: () => request<{ items: Loan[] }>('/v1/me/loans') }); }
export function useRefunds(role: 'buyer' | 'seller') {
  return useInfiniteQuery({
    queryKey: ['refunds', role],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) => request<{ items: RefundRequest[]; nextCursor: string | null }>(`/v1/me/refunds?role=${role}&limit=25${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}
export function useAidRequests() { return useQuery({ queryKey: ['aid-requests'], queryFn: () => request<{ items: AidRequest[] }>('/v1/me/aid-requests') }); }
export function useCharities() { return useQuery({ queryKey: ['charities'], queryFn: () => request<{ items: Charity[] }>('/v1/me/charities') }); }
export function useCharityRequests() { return useQuery({ queryKey: ['charity-requests'], queryFn: () => request<{ items: AidRequest[] }>('/v1/me/charity-requests') }); }
export function useInvalidateMoney() {
  const client = useQueryClient();
  return () => Promise.all([client.invalidateQueries({ queryKey: ['me'] }), client.invalidateQueries({ queryKey: ['identity'] }), client.invalidateQueries({ queryKey: ['balance'] }), client.invalidateQueries({ queryKey: ['withdrawal-availability'] }), client.invalidateQueries({ queryKey: ['transactions'] }), client.invalidateQueries({ queryKey: ['loans'] }), client.invalidateQueries({ queryKey: ['refunds'] }), client.invalidateQueries({ queryKey: ['aid-requests'] }), client.invalidateQueries({ queryKey: ['charity-requests'] })]);
}

export type { TransactionsPage };
