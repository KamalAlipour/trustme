'use server';

import { redirect } from 'next/navigation';
import { adminApiFetch } from '../../lib/api';

export async function approveWithdrawalAction(formData: FormData): Promise<void> {
  await adminApiFetch(`/admin/withdrawals/${encodeURIComponent(String(formData.get('id') ?? ''))}/approve`, { method: 'POST' });
  redirect('/withdrawals');
}

export async function rejectWithdrawalAction(formData: FormData): Promise<void> {
  await adminApiFetch(`/admin/withdrawals/${encodeURIComponent(String(formData.get('id') ?? ''))}/reject`, { method: 'POST' });
  redirect('/withdrawals');
}
