import { useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './api/client';
import type { Balance, Contact, Loan, Member, TransactionsPage, WithdrawalAvailability } from './api/types';

export function useMember() { return useQuery({ queryKey: ['me'], queryFn: () => request<Member>('/v1/me') }); }
export function useBalance() { return useQuery({ queryKey: ['balance'], queryFn: () => request<Balance>('/v1/me/balance') }); }
export function useAvailability() { return useQuery({ queryKey: ['withdrawal-availability'], queryFn: () => request<WithdrawalAvailability>('/v1/me/withdrawal-availability') }); }
export function useContacts(query = '', sort: 'alias' | 'recent' = 'alias') { return useQuery({ queryKey: ['contacts', query, sort], queryFn: () => request<{ items: Contact[] }>(`/v1/me/contacts?query=${encodeURIComponent(query)}&sort=${sort}`) }); }
export function useLoans() { return useQuery({ queryKey: ['loans'], queryFn: () => request<{ items: Loan[] }>('/v1/me/loans') }); }
export function useInvalidateMoney() {
  const client = useQueryClient();
  return () => Promise.all([client.invalidateQueries({ queryKey: ['me'] }), client.invalidateQueries({ queryKey: ['balance'] }), client.invalidateQueries({ queryKey: ['withdrawal-availability'] }), client.invalidateQueries({ queryKey: ['transactions'] }), client.invalidateQueries({ queryKey: ['loans'] })]);
}

export type { TransactionsPage };
