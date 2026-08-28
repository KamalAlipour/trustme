import { PrismaClient } from '@trustme/db';
import type { ChainProvider } from './provider.js';

export type ChainHealthConfig = {
  chainMaxBlockAgeSeconds?: number;
};

export async function assertChainHealthy(
  prisma: PrismaClient,
  provider: ChainProvider,
  config: ChainHealthConfig,
): Promise<number> {
  const head = await provider.getBlockNumber();
  const cursor = await prisma.chainCursor.findUnique({ where: { id: 1 }, select: { nextBlock: true } });
  if (cursor !== null && BigInt(head) < cursor.nextBlock) throw new Error('chain head is behind the stored cursor');
  const blockTimestamp = await provider.getBlockTimestamp(head);
  if (blockTimestamp === null || Math.floor(Date.now() / 1000) - blockTimestamp > (config.chainMaxBlockAgeSeconds ?? 120)) {
    throw new Error('chain head is stale');
  }
  return head;
}
