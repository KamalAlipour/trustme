import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { HDNodeWallet, JsonRpcProvider } from 'ethers';
import { UnrecoverableError, Worker as BullWorker } from 'bullmq';
import { pino } from 'pino';
import { DepositSweepStatus, PrismaClient, WithdrawalStatus } from '@trustme/db';
import { createEthersProvider, createWalletSigner } from './provider.js';
import { loadWorkerConfig, type WorkerConfig } from './config.js';
import { ingestOnce } from './ingest.js';
import { ingestEscrowOnce } from './escrow-ingest.js';
import { confirmWithdrawal, dispatchWithdrawal } from './dispatch.js';
import { confirmEscrowSettlement, confirmEscrowUnload, dispatchEscrowSettlement, dispatchEscrowUnload } from './escrow-dispatch.js';
import { cleanupUnattachedMedia } from './media-cleanup.js';
import { expireBalanceDisclosures } from './disclosure-cleanup.js';
import { churnDemoCoupons } from './demo-churn.js';
import { fundSweepGas, sweepDepositAddress } from './sweep.js';
import { CONFIRMATION_QUEUE, createQueues, DISPATCH_QUEUE, INGEST_QUEUE, SMS_QUEUE, SWEEP_QUEUE, type WorkerQueues } from './queues.js';
import { sendOtp } from './sms-relay.js';

export { loadWorkerConfig } from './config.js';
export * from './provider.js';
export * from './ingest.js';
export * from './escrow-ingest.js';
export * from './dispatch.js';
export * from './escrow-dispatch.js';
export * from './queues.js';
export * from './sweep.js';

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
    const cleanedMnemonic = mnemonic
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
      .join(' ')
      .trim();
    node = HDNodeWallet.fromPhrase(cleanedMnemonic, undefined, config.depositDerivationPath);
  } catch {
    throw new Error('deposit wallet mnemonic is invalid');
  }
  if (node.neuter().extendedKey !== config.depositXpub) {
    throw new Error(`deposit wallet xpub does not match configured derivation path ${config.depositDerivationPath}`);
  }
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
    redact: ['code', 'privateKey', 'HOT_WALLET_PRIVATE_KEY', 'ESCROW_SETTLER_KEY', 'authorization', 'token', 'mnemonic', 'phrase', 'DEPOSIT_WALLET_MNEMONIC', 'xpub'],
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
  const escrowSigner = config.escrowSettlerKey === undefined ? null : createWalletSigner(config.escrowSettlerKey, rpc);
  if (config.escrowContractAddress === undefined || config.escrowSettlerKey === undefined) {
    logger.warn('escrow dispatch disabled: ESCROW_CONTRACT_ADDRESS or ESCROW_SETTLER_KEY is not configured');
  }
  const sweepConfig = { ...config, hotWalletAddress: signer.address };
  const queues = createQueues(config.redisUrl);
  const ingestWorker = new BullWorker(
    INGEST_QUEUE,
    async (job) => {
      if (job.name === 'media-cleanup') {
        await expireBalanceDisclosures(prisma);
        return cleanupUnattachedMedia(prisma, config.mediaStorageDir);
      }
      if (job.name === 'demo-churn') {
        return churnDemoCoupons(prisma, {
          enabled: config.allowDemoData,
          transfersPerTick: config.demoChurnTransfersPerTick,
          maxCouponsPerTransfer: config.demoChurnMaxCoupons,
        }, logger);
      }
      if (job.name === 'escrow-ingest') {
        return ingestEscrowOnce(prisma, provider, config, logger);
      }
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
  const smsWorker = new BullWorker(
    SMS_QUEUE,
    async (job) => {
      const row = await prisma.phoneVerification.findUnique({ where: { id: String(job.data.phoneVerificationId) } });
      if (row === null || row.consumedAt !== null || row.expiresAt <= new Date() || row.deliveryStatus !== 'PENDING') return;
      const result = await sendOtp(config, { recipient: String(job.data.phone), code: String(job.data.code) });
      if (result.kind === 'sent') {
        await prisma.phoneVerification.update({ where: { id: row.id }, data: { deliveryStatus: 'SENT', relayMessageId: result.messageId } });
        return result;
      }
      if (result.kind === 'terminal') {
        await prisma.phoneVerification.update({ where: { id: row.id }, data: { deliveryStatus: 'FAILED', deliveryError: `relay_${result.status}` } });
        throw new UnrecoverableError(`SMS relay terminal status ${result.status}`);
      }
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
        await prisma.phoneVerification.update({ where: { id: row.id }, data: { deliveryStatus: 'FAILED', deliveryError: result.status === null ? 'network' : `relay_${result.status}` } });
      }
      throw new Error(result.status === null ? 'SMS relay network failure' : `SMS relay status ${result.status}`);
    },
    {
      connection: queues.connection,
      concurrency: 1,
      settings: {
        backoffStrategy: (attemptsMade, type) => type === 'sms-relay' ? [5_000, 30_000, 120_000][attemptsMade] ?? 120_000 : 0,
      },
    },
  );
  const dispatchWorker = new BullWorker(
    DISPATCH_QUEUE,
    async (job) => {
      if (job.name === 'escrow-settle') {
        if (escrowSigner === null || config.escrowContractAddress === undefined) {
          logger.warn('escrow settlement disabled: ESCROW_SETTLER_KEY or ESCROW_CONTRACT_ADDRESS is not configured');
          return { status: 'disabled' };
        }
        const result = await dispatchEscrowSettlement(prisma, provider, escrowSigner, config, String(job.data.settlementId));
        if (result.txHash !== undefined) await queues.confirmation.add('escrow-settle-confirm', job.data, { delay: 15_000, jobId: `escrow-settlement-confirm:${job.data.settlementId}` });
        return result;
      }
      if (job.name === 'escrow-unload') {
        if (escrowSigner === null || config.escrowContractAddress === undefined) {
          logger.warn('escrow unload disabled: ESCROW_SETTLER_KEY or ESCROW_CONTRACT_ADDRESS is not configured');
          return { status: 'disabled' };
        }
        const result = await dispatchEscrowUnload(prisma, provider, escrowSigner, config, String(job.data.unloadId));
        if (result.txHash !== undefined) await queues.confirmation.add('escrow-unload-confirm', job.data, { delay: 15_000, jobId: `escrow-unload-confirm:${job.data.unloadId}` });
        return result;
      }
      if (job.name === 'sweep-gas') {
        if (depositAccountNode === null) return { status: 'disabled' };
        const result = await fundSweepGas(prisma, provider, depositAccountNode, signer, sweepConfig, String(job.data.sweepId));
        if (result.status === 'broadcast') {
          await queues.sweep.add('sweep', { depositAddressId: result.depositAddressId }, { delay: 15_000, jobId: `sweep:${result.depositAddressId}`, removeOnComplete: true });
        } else if (result.status === 'ready') {
          await queues.sweep.add('sweep', { depositAddressId: result.depositAddressId }, { jobId: `sweep:${result.depositAddressId}`, removeOnComplete: true });
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
      if (job.name === 'escrow-settle-confirm') {
        const result = await confirmEscrowSettlement(prisma, provider, String(job.data.settlementId));
        if (result.status === 'waiting') await queues.confirmation.add('escrow-settle-confirm', job.data, { delay: 15_000, jobId: `escrow-settlement-confirm:${job.data.settlementId}:${Date.now()}` });
        return result;
      }
      if (job.name === 'escrow-unload-confirm') {
        const result = await confirmEscrowUnload(prisma, provider, String(job.data.unloadId));
        if (result.status === 'waiting') await queues.confirmation.add('escrow-unload-confirm', job.data, { delay: 15_000, jobId: `escrow-unload-confirm:${job.data.unloadId}:${Date.now()}` });
        return result;
      }
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
  const workers = [ingestWorker, dispatchWorker, confirmationWorker, sweepWorker, smsWorker];
  await queues.ingest.add('scan', {}, { jobId: 'chain-ingest-repeat', repeat: { every: 15_000 } });
  await queues.ingest.add('escrow-ingest', {}, { jobId: 'escrow-ingest-repeat', repeat: { every: 15_000 } });
  await queues.ingest.add('media-cleanup', {}, { jobId: 'media-cleanup-repeat', repeat: { every: 60 * 60_000 } });
  const demoChurnSchedules = await queues.ingest.getRepeatableJobs();
  await Promise.all(demoChurnSchedules
    .filter((job) => job.name === 'demo-churn' && job.id === 'demo-churn-repeat')
    .map((job) => queues.ingest.removeRepeatableByKey(job.key)));
  if (config.allowDemoData) {
    await queues.ingest.add('demo-churn', {}, { jobId: 'demo-churn-repeat', repeat: { every: config.demoChurnIntervalMs } });
  }
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
  const pendingSettlements = await prisma.escrowSettlement.findMany({ where: { status: 'PENDING', chainTxHash: { not: null } }, select: { id: true } });
  await Promise.all(pendingSettlements.map((row) => queues.confirmation.add('escrow-settle-confirm', { settlementId: row.id }, { jobId: `escrow-settlement-confirm:${row.id}` })));
  const pendingUnloads = await prisma.escrowUnload.findMany({ where: { status: 'PENDING', chainTxHash: { not: null } }, select: { id: true } });
  await Promise.all(pendingUnloads.map((row) => queues.confirmation.add('escrow-unload-confirm', { unloadId: row.id }, { jobId: `escrow-unload-confirm:${row.id}` })));
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
