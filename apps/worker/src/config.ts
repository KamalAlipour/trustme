import { z } from 'zod';

const integer = z.coerce.number().int().nonnegative();
const positiveInteger = z.coerce.number().int().positive();
const optionalString = z.preprocess((value) => value === '' ? undefined : value, z.string().min(1).optional());

export const workerConfigSchema = z.object({
  databaseUrl: z.string().min(1),
  redisUrl: z.string().min(1),
  polygonRpcUrl: z.string().url(),
  usdtContractAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  hotWalletPrivateKey: z.string().min(1),
  depositWalletMnemonicPath: z.string().default('/etc/trustme/deposit-wallet.txt'),
  depositDerivationPath: z.string().default("m/44'/60'/0'/0"),
  depositXpub: optionalString,
  chainId: positiveInteger.default(137),
  gasSafetyMultiplierBps: positiveInteger.default(12_500),
  gasLimitCeiling: positiveInteger.default(200_000),
  chainStartBlock: integer.default(0),
  confirmations: integer.default(12),
  maxBlockRange: integer.default(2_000).refine((value) => value > 0),
  ingestChunksPerTick: positiveInteger.default(20),
  reorgRewindBlocks: integer.default(64).refine((value) => value > 0),
  chainMaxBlockAgeSeconds: positiveInteger.default(120),
  sweepMinMicroUsdt: positiveInteger.default(1_000_000),
  sweepMaxGasTopUpWei: z.coerce.bigint().positive().default(500_000_000_000_000_000n),
  sweepScanIntervalMs: positiveInteger.default(60_000),
  sweepBatchSize: positiveInteger.default(25),
  sweepFailureBackoffMs: positiveInteger.default(900_000),
  sweepMaxAttempts: positiveInteger.default(5),
  failoverMarkerPath: z.string().default('/etc/trustme/FAILED_OVER'),
  mediaStorageDir: z.string().default('/var/lib/trustme/media'),
  allowDemoData: z.boolean().default(false),
  demoChurnIntervalMs: positiveInteger.default(30_000),
  demoChurnTransfersPerTick: positiveInteger.default(3),
  demoChurnMaxCoupons: positiveInteger.default(50),
});

export type WorkerConfig = z.infer<typeof workerConfigSchema>;

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return workerConfigSchema.parse({
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    polygonRpcUrl: env.POLYGON_RPC_URL,
    usdtContractAddress: env.USDT_CONTRACT_ADDRESS,
    hotWalletPrivateKey: env.HOT_WALLET_PRIVATE_KEY,
    depositWalletMnemonicPath: env.DEPOSIT_WALLET_MNEMONIC_PATH,
    depositDerivationPath: env.DEPOSIT_DERIVATION_PATH,
    depositXpub: env.DEPOSIT_XPUB,
    chainId: env.CHAIN_ID,
    gasSafetyMultiplierBps: env.GAS_SAFETY_MULTIPLIER_BPS,
    gasLimitCeiling: env.GAS_LIMIT_CEILING,
    chainStartBlock: env.CHAIN_START_BLOCK,
    confirmations: env.CONFIRMATIONS,
    maxBlockRange: env.MAX_BLOCK_RANGE,
    ingestChunksPerTick: env.INGEST_CHUNKS_PER_TICK,
    reorgRewindBlocks: env.REORG_REWIND_BLOCKS,
    chainMaxBlockAgeSeconds: env.CHAIN_MAX_BLOCK_AGE_SECONDS,
    sweepMinMicroUsdt: env.SWEEP_MIN_MICRO_USDT,
    sweepMaxGasTopUpWei: env.SWEEP_MAX_GAS_TOP_UP_WEI,
    sweepScanIntervalMs: env.SWEEP_SCAN_INTERVAL_MS,
    sweepBatchSize: env.SWEEP_BATCH_SIZE,
    sweepFailureBackoffMs: env.SWEEP_FAILURE_BACKOFF_MS,
    sweepMaxAttempts: env.SWEEP_MAX_ATTEMPTS,
    failoverMarkerPath: env.FAILOVER_MARKER_PATH,
    mediaStorageDir: env.MEDIA_STORAGE_DIR,
    allowDemoData: env.ALLOW_DEMO_DATA === 'true',
    demoChurnIntervalMs: env.DEMO_CHURN_INTERVAL_MS,
    demoChurnTransfersPerTick: env.DEMO_CHURN_TRANSFERS_PER_TICK,
    demoChurnMaxCoupons: env.DEMO_CHURN_MAX_COUPONS,
  });
}
