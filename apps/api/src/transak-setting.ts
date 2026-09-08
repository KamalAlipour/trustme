import { PrismaClient } from '@trustme/db';
import { HttpError } from './http-error.js';

export async function transakEnabled(prisma: PrismaClient): Promise<boolean> {
  const row = await prisma.systemSetting.findUnique({
    where: { key: 'TRANSAK_ENABLED' },
    select: { value: true },
  });
  return row?.value === 'true';
}

export async function requireTransak(prisma: PrismaClient): Promise<void> {
  if (!(await transakEnabled(prisma))) {
    throw new HttpError(409, 'Transak is disabled');
  }
}
