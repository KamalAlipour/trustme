import { BalanceDisclosureStatus, PrismaClient } from '@trustme/db';

export async function expireBalanceDisclosures(prisma: PrismaClient): Promise<number> {
  const result = await prisma.balanceDisclosureRequest.updateMany({
    where: { status: BalanceDisclosureStatus.PENDING, expiresAt: { lte: new Date() } },
    data: { status: BalanceDisclosureStatus.EXPIRED, resolvedAt: new Date() },
  });
  return result.count;
}
