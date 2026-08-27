import { z } from 'zod';

const integer = z.coerce.number().int().nonnegative();

export const workerConfigSchema = z.object({
  databaseUrl: z.string().min(1),
  redisUrl: z.string().min(1),
  polygonRpcUrl: z.string().url(),
  usdtContractAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  hotWalletPrivateKey: z.string().min(1),
  chainStartBlock: integer.default(0),
  confirmations: integer.default(12),
  maxBlockRange: integer.default(2_000).refine((value) => value > 0),
  reorgRewindBlocks: integer.default(64).refine((value) => value > 0),
  failoverMarkerPath: z.string().default('/root/mirror/FAILED_OVER'),
});

export type WorkerConfig = z.infer<typeof workerConfigSchema>;

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return workerConfigSchema.parse({
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    polygonRpcUrl: env.POLYGON_RPC_URL,
    usdtContractAddress: env.USDT_CONTRACT_ADDRESS,
    hotWalletPrivateKey: env.HOT_WALLET_PRIVATE_KEY,
    chainStartBlock: env.CHAIN_START_BLOCK,
    confirmations: env.CONFIRMATIONS,
    maxBlockRange: env.MAX_BLOCK_RANGE,
    reorgRewindBlocks: env.REORG_REWIND_BLOCKS,
    failoverMarkerPath: env.FAILOVER_MARKER_PATH,
  });
}
