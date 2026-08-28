import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { HDNodeWallet, JsonRpcProvider } from 'ethers';
import { Worker as BullWorker } from 'bullmq';
import { pino } from 'pino';
import { DepositSweepStatus, PrismaClient, WithdrawalStatus } from '@trustme/db';
import { createEthersProvider, createWalletSigner } from './provider.js';
import { loadWorkerConfig, type WorkerConfig } from './config.js';
import { ingestOnce } from './ingest.js';
import { confirmWithdrawal, dispatchWithdrawal } from './dispatch.js';
import { cleanupUnattachedMedia } from './media-cleanup.js';
import { fundSweepGas, sweepDepositAddress } from './sweep.js';
import { CONFIRMATION_QUEUE, createQueues, DISPATCH_QUEUE, INGEST_QUEUE, SWEEP_QUEUE, type WorkerQueues } from './queues.js';

export { loadWorkerConfig } from './config.js';
export * from './provider.js';
export * from './ingest.js';
export * from './dispatch.js';
export * from './queues.js';
export * from './sweep.js';

const depositDerivationPath = "m/44'/60'/0'/0";

export async function loadDepositAccountNode(
  config: WorkerConfig,
  log: { warn: (message: string) => void },
): Promise<HDNodeWallet | null> {
  if (config.depositXpub === undefined) {
    log.warn('deposit sweeping disabled: DEPOSIT_XPUB is not configured');
    return null;
  }
  let mnemonic: string;
  try {
    mnemonic = await readFile(config.depositWalletMnemonicPath, 'utf8');
  } catch {
    log.warn('deposit sweeping disabled: deposit wallet mnemonic is unavailable');
    return null;
  }
  let node: HDNodeWallet;
  try {
    node = HDNodeWallet.fromPhrase(mnemonic.trim(), undefined, depositDerivationPath);
  } catch {
    throw new Error('deposit wallet mnemonic is invalid');
  }
  if (node.neuter().extendedKey !== config.depositXpub) throw new Error('deposit wallet xpub does not match configured xpub');
  return node;
}

export async function startWorker(config: WorkerConfig = loadWorkerConfig()): Promise<{
  prisma: PrismaClient;
  queues: WorkerQueues;
  workers: BullWorker[];
}> {
  if (existsSync(config.failoverMarkerPath)) {
    throw new Error(`failover marker exists at ${config.failoverMarkerPath}; refusing to start worker`);
  }
  const logger = pino({
    redact: ['code', 'privateKey', 'HOT_WALLET_PRIVATE_KEY', 'authorization', 'token', 'mnemonic', 'phrase', 'DEPOSIT_WALLET_MNEMONIC', 'xpub'],
  });
  const depositAccountNode = await loadDepositAccountNode(config, logger);
  const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  const rpc = new JsonRpcProvider(config.polygonRpcUrl);
  const provider = createEthersProvider(rpc);
  const chainId = await provider.getChainId();
  if (chainId !== BigInt(config.chainId)) {
    await prisma.$disconnect();
    throw new Error(`configured chain ID ${config.chainId} does not match provider chain ID ${chainId}`);
  }
  const signer = createWalletSigner(config.hotWalletPrivateKey, rpc);
  const sweepConfig = { ...config, hotWalletAddress: signer.address };
  const queues = createQueues(config.redisUrl);
  const ingestWorker = new BullWorker(
    INGEST_QUEUE,
    async (job) => {
      if (job.name === 'media-cleanup') return cleanupUnattachedMedia(prisma, config.mediaStorageDir);
      const result = await ingestOnce(prisma, provider, config, logger);
      await Promise.all(result.sweepDepositAddressIds.map((depositAddressId) => queues.sweep.add(
        'sweep',
        { depositAddressId },
        { jobId: `sweep:${depositAddressId}`, removeOnComplete: true },
      )));
      return result;
    },
    { connection: queues.connection, concurrency: 1 },
  );
  const dispatchWorker = new BullWorker(
    DISPATCH_QUEUE,
    async (job) => {
      if (job.name === 'sweep-gas') {
        if (depositAccountNode === null) return { status: 'disabled' };
        const result = await fundSweepGas(prisma, provider, depositAccountNode, signer, sweepConfig, String(job.data.sweepId));
        if (result.status === 'broadcast') {
          await queues.sweep.add('sweep', { depositAddressId: (await prisma.depositSweep.findUniqueOrThrow({
            where: { id: result.sweepId },
            select: { depositAddressId: true },
          })).depositAddressId }, { delay: 15_000, jobId: `sweep:${result.sweepId}`, removeOnComplete: true });
        } else if (result.status === 'ready') {
          await queues.sweep.add('sweep', { depositAddressId: (await prisma.depositSweep.findUniqueOrThrow({
            where: { id: result.sweepId },
            select: { depositAddressId: true },
          })).depositAddressId }, { jobId: `sweep:${result.sweepId}`, removeOnComplete: true });
        }
        return result;
      }
      const result = await dispatchWithdrawal(prisma, provider, signer, config, String(job.data.withdrawalId), logger);
      if (result.status !== 'skipped') {
        await queues.confirmation.add('confirm', { withdrawalId: job.data.withdrawalId }, {
          jobId: `confirmation:${job.data.withdrawalId}`,
        });
      }
      return result;
    },
    { connection: queues.connection, concurrency: 1 },
  );
  const confirmationWorker = new BullWorker(
    CONFIRMATION_QUEUE,
    async (job) => {
      const result = await confirmWithdrawal(prisma, provider, config, String(job.data.withdrawalId), logger);
      if (result?.status === 'waiting') {
        await queues.confirmation.add('confirm', job.data, { delay: 15_000, jobId: `confirmation:${job.data.withdrawalId}:${Date.now()}` });
      }
      return result;
    },
    { connection: queues.connection, concurrency: 1 },
  );
  const sweepWorker = new BullWorker(
    SWEEP_QUEUE,
    async (job) => {
      if (job.name === 'sweep-scan') {
        if (depositAccountNode === null) return { status: 'disabled' };
        const addresses = await prisma.depositAddress.findMany({
          where: { sweepPendingAt: { not: null } },
          orderBy: { sweepPendingAt: 'asc' },
          take: config.sweepBatchSize,
          select: { id: true },
        });
        await Promise.all(addresses.map(({ id }) => queues.sweep.add(
          'sweep',
          { depositAddressId: id },
          { jobId: `sweep:${id}`, removeOnComplete: true },
        )));
        return { status: 'enqueued', count: addresses.length };
      }
      if (depositAccountNode === null) return { status: 'disabled' };
      const result = await sweepDepositAddress(prisma, provider, depositAccountNode, sweepConfig, String(job.data.depositAddressId));
      const sweepId = 'sweepId' in result ? result.sweepId : undefined;
      if (sweepId !== undefined && (result.status === 'gas-funding')) {
        await queues.dispatch.add('sweep-gas', { sweepId }, { jobId: `sweep-gas:${sweepId}` });
      } else if (result.status === 'waiting' || result.status === 'broadcast') {
        await queues.sweep.add('sweep', job.data, { delay: 15_000, jobId: `sweep:${job.data.depositAddressId}`, removeOnComplete: true });
      }
      return result;
    },
    { connection: queues.connection, concurrency: 1 },
  );
  const workers = [ingestWorker, dispatchWorker, confirmationWorker, sweepWorker];
  await queues.ingest.add('scan', {}, { jobId: 'chain-ingest-repeat', repeat: { every: 15_000 } });
  await queues.ingest.add('media-cleanup', {}, { jobId: 'media-cleanup-repeat', repeat: { every: 60 * 60_000 } });
  await queues.sweep.add('sweep-scan', {}, { jobId: 'sweep-scan-repeat', repeat: { every: config.sweepScanIntervalMs } });
  const inFlight = await prisma.withdrawal.findMany({
    where: { status: WithdrawalStatus.PROCESSING, chainTxHash: { not: null } },
    select: { id: true },
  });
  await Promise.all(inFlight.map((withdrawal) => queues.confirmation.add('confirm', { withdrawalId: withdrawal.id }, { jobId: `confirmation:${withdrawal.id}` })));
  const approved = await prisma.withdrawal.findMany({
    where: { status: WithdrawalStatus.APPROVED, chainTxHash: null },
    select: { id: true },
  });
  await Promise.all(approved.map((withdrawal) => queues.dispatch.add('dispatch', { withdrawalId: withdrawal.id }, { jobId: withdrawal.id })));
  const inFlightSweeps = await prisma.depositSweep.findMany({
    where: { status: { in: [DepositSweepStatus.PENDING, DepositSweepStatus.GAS_FUNDING, DepositSweepStatus.BROADCAST] } },
    select: { depositAddressId: true },
  });
  await Promise.all(inFlightSweeps.map((sweep) => queues.sweep.add(
    'sweep',
    { depositAddressId: sweep.depositAddressId },
    { jobId: `sweep:${sweep.depositAddressId}`, removeOnComplete: true },
  )));
  logger.info('TrustMe worker started');
  return { prisma, queues, workers };
}

if (process.argv[1]?.endsWith('/index.js')) {
  startWorker().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'worker startup failed'}\n`);
    process.exitCode = 1;
  });
}
