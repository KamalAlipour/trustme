import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaClient } from '@trustme/db';

export async function cleanupUnattachedMedia(prisma: PrismaClient, storageDir: string): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const assets = await prisma.mediaAsset.findMany({
    where: { refundRequestId: null, aidRequestId: null, createdAt: { lt: cutoff } },
    select: { id: true, storageKey: true },
  });
  for (const asset of assets) {
    const deleted = await prisma.mediaAsset.deleteMany({
      where: { id: asset.id, refundRequestId: null, aidRequestId: null },
    });
    if (deleted.count === 1) await rm(join(storageDir, asset.storageKey), { force: true });
  }
  return assets.length;
}
