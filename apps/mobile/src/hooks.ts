import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './api/client';
import type { AidRequest, Balance, BalanceDisclosure, Charity, Contact, EscrowBalance, EscrowConfig, EscrowSettlement, EscrowUnload, IdentityInfo, Loan, Member, RefundRequest, TransactionsPage, WithdrawalAvailability } from './api/types';

export function useMember() { return useQuery({ queryKey: ['me'], queryFn: () => request<Member>('/v1/me') }); }
export function useBalance() { return useQuery({ queryKey: ['balance'], queryFn: () => request<Balance>('/v1/me/balance') }); }
export function useIdentity() { return useQuery({ queryKey: ['identity'], queryFn: () => request<IdentityInfo>('/v1/me/identity') }); }
export function useDisclosures() { return useQuery({ queryKey: ['disclosures'], queryFn: () => request<{ items: BalanceDisclosure[] }>('/v1/me/disclosures'), refetchInterval: 30_000 }); }
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
export function useEscrowConfig() { return useQuery({ queryKey: ['escrow-config'], queryFn: () => request<EscrowConfig>('/v1/me/escrow/config'), staleTime: 60_000 }); }
export function useEscrowBalance(enabled = true) { return useQuery({ queryKey: ['escrow-balance'], queryFn: () => request<EscrowBalance>('/v1/me/escrow'), enabled, refetchInterval: 10_000 }); }
export function useEscrowSettlements(enabled = true) { return useQuery({ queryKey: ['escrow-settlements'], queryFn: () => request<{ items: EscrowSettlement[]; nextCursor: string | null }>('/v1/me/escrow/settlements'), enabled, refetchInterval: 10_000 }); }
export function useEscrowUnloads(enabled = true) { return useQuery({ queryKey: ['escrow-unloads'], queryFn: () => request<{ items: EscrowUnload[]; nextCursor: string | null }>('/v1/me/escrow/unloads'), enabled, refetchInterval: 10_000 }); }
export function useInvalidateMoney() {
  const client = useQueryClient();
  return () => Promise.all([client.invalidateQueries({ queryKey: ['me'] }), client.invalidateQueries({ queryKey: ['identity'] }), client.invalidateQueries({ queryKey: ['disclosures'] }), client.invalidateQueries({ queryKey: ['balance'] }), client.invalidateQueries({ queryKey: ['withdrawal-availability'] }), client.invalidateQueries({ queryKey: ['transactions'] }), client.invalidateQueries({ queryKey: ['loans'] }), client.invalidateQueries({ queryKey: ['refunds'] }), client.invalidateQueries({ queryKey: ['aid-requests'] }), client.invalidateQueries({ queryKey: ['charity-requests'] }), client.invalidateQueries({ queryKey: ['escrow-balance'] }), client.invalidateQueries({ queryKey: ['escrow-settlements'] }), client.invalidateQueries({ queryKey: ['escrow-unloads'] })]);
}

export type { TransactionsPage };
