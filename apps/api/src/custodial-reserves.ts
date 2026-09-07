import { PrismaClient } from '@trustme/db';
import { HttpError } from './http-error.js';

export async function custodialReservesEnabled(prisma: PrismaClient): Promise<boolean> {
  const row = await prisma.systemSetting.findUnique({
    where: { key: 'CUSTODIAL_RESERVES_ENABLED' },
    select: { value: true },
  });
  return row?.value === 'true';
}

export async function requireCustodialReserves(prisma: PrismaClient): Promise<void> {
  if (!(await custodialReservesEnabled(prisma))) {
    throw new HttpError(409, 'custodial reserves are disabled');
  }
}
