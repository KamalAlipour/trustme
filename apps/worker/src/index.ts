import { existsSync } from 'node:fs';
import { JsonRpcProvider } from 'ethers';
import { Worker as BullWorker } from 'bullmq';
import { pino } from 'pino';
import { PrismaClient, WithdrawalStatus } from '@trustme/db';
import { createEthersProvider, createWalletSigner } from './provider.js';
import { loadWorkerConfig, type WorkerConfig } from './config.js';
import { ingestOnce } from './ingest.js';
import { confirmWithdrawal, dispatchWithdrawal } from './dispatch.js';
import { CONFIRMATION_QUEUE, createQueues, DISPATCH_QUEUE, INGEST_QUEUE, type WorkerQueues } from './queues.js';

export { loadWorkerConfig } from './config.js';
export * from './provider.js';
export * from './ingest.js';
export * from './dispatch.js';
export * from './queues.js';

export async function startWorker(config: WorkerConfig = loadWorkerConfig()): Promise<{
  prisma: PrismaClient;
  queues: WorkerQueues;
  workers: BullWorker[];
}> {
  if (existsSync(config.failoverMarkerPath)) {
    throw new Error(`failover marker exists at ${config.failoverMarkerPath}; refusing to start worker`);
  }
  const logger = pino({ redact: ['code', 'privateKey', 'HOT_WALLET_PRIVATE_KEY', 'authorization', 'token'] });
  const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  const rpc = new JsonRpcProvider(config.polygonRpcUrl);
  const provider = createEthersProvider(config.polygonRpcUrl);
  const signer = createWalletSigner(config.hotWalletPrivateKey, rpc);
  const queues = createQueues(config.redisUrl);
  const ingestWorker = new BullWorker(
    INGEST_QUEUE,
    async () => ingestOnce(prisma, provider, config, logger),
    { connection: queues.connection, concurrency: 1 },
  );
  const dispatchWorker = new BullWorker(
    DISPATCH_QUEUE,
    async (job) => {
      const result = await dispatchWithdrawal(prisma, provider, signer, config, String(job.data.withdrawalId));
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
  const workers = [ingestWorker, dispatchWorker, confirmationWorker];
  await queues.ingest.add('scan', {}, { jobId: 'chain-ingest-repeat', repeat: { every: 15_000 } });
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
  logger.info('TrustMe worker started');
  return { prisma, queues, workers };
}

if (process.argv[1]?.endsWith('/index.js')) {
  startWorker().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'worker startup failed'}\n`);
    process.exitCode = 1;
  });
}
