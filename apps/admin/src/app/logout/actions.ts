'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ADMIN_TOKEN_COOKIE } from '../../constants';

export async function logoutAction(): Promise<void> {
  (await cookies()).delete(ADMIN_TOKEN_COOKIE);
  redirect('/login');
}
