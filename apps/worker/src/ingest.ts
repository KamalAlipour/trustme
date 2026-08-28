import { id, getAddress } from 'ethers';
import { AccountType, Asset, Prisma, PrismaClient } from '@trustme/db';
import { postDeposit } from '@trustme/core';
import type { ChainLog, ChainProvider } from './provider.js';

const transferTopic = id('Transfer(address,address,uint256)');

export type IngestConfig = {
  usdtContractAddress: string;
  chainStartBlock: number;
  confirmations: number;
  maxBlockRange: number;
  ingestChunksPerTick: number;
  reorgRewindBlocks: number;
};

export type IngestResult = {
  processed: number;
  ignored: number;
  rewound: boolean;
  scannedThrough: number | null;
  sweepDepositAddressIds: string[];
};

async function getCursor(prisma: PrismaClient, startBlock: number) {
  return (
    (await prisma.chainCursor.findUnique({ where: { id: 1 } })) ??
    (await prisma.chainCursor.create({ data: { id: 1, nextBlock: BigInt(startBlock) } }))
  );
}

function decodeTransfer(log: ChainLog): { to: string; amount: bigint } | null {
  if (log.topics[0] !== transferTopic || !log.topics[2] || !/^0x[0-9a-fA-F]{64}$/.test(log.topics[2])) return null;
  try {
    return {
      to: getAddress(`0x${log.topics[2].slice(-40)}`),
      amount: BigInt(log.data),
    };
  } catch {
    return null;
  }
}

async function matchingDeposits(prisma: PrismaClient, logs: ChainLog[]) {
  const addresses = [...new Set(logs.map((log) => decodeTransfer(log)?.to).filter((address): address is string => address !== undefined))];
  if (addresses.length === 0) return new Map<string, { id: string; userId: string; address: string }>();
  const rows = await prisma.$queryRaw<Array<{ id: string; userId: string; address: string }>>(
    Prisma.sql`SELECT "id", "userId", "address" FROM "DepositAddress" WHERE lower("address") IN (${Prisma.join(addresses.map((address) => Prisma.sql`${address.toLowerCase()}`))})`,
  );
  return new Map(rows.map((row) => [row.address.toLowerCase(), row]));
}

async function systemAccount(prisma: PrismaClient, type: AccountType, asset: Asset) {
  return prisma.ledgerAccount.findFirstOrThrow({ where: { type, asset, userId: null } });
}

export async function ingestOnce(
  prisma: PrismaClient,
  provider: ChainProvider,
  config: IngestConfig,
  log: Pick<Console, 'error'> = console,
): Promise<IngestResult> {
  let processed = 0;
  let ignored = 0;
  let rewound = false;
  let scannedThrough: number | null = null;
  const sweepDepositAddressIds = new Set<string>();
  for (let chunk = 0; chunk < config.ingestChunksPerTick; chunk += 1) {
    const result = await ingestRange(prisma, provider, config, log);
    processed += result.processed;
    ignored += result.ignored;
    rewound ||= result.rewound;
    if (result.scannedThrough !== null) scannedThrough = result.scannedThrough;
    for (const depositAddressId of result.sweepDepositAddressIds) sweepDepositAddressIds.add(depositAddressId);
    if (result.rewound || result.scannedThrough === null) break;
  }
  return { processed, ignored, rewound, scannedThrough, sweepDepositAddressIds: [...sweepDepositAddressIds] };
}

async function ingestRange(
  prisma: PrismaClient,
  provider: ChainProvider,
  config: IngestConfig,
  log: Pick<Console, 'error'>,
): Promise<IngestResult> {
  const cursor = await getCursor(prisma, config.chainStartBlock);
  const nextBlock = Number(cursor.nextBlock);
  if (cursor.lastBlockHash !== null && nextBlock > config.chainStartBlock) {
    const previousHash = await provider.getBlockHash(nextBlock - 1);
    if (previousHash === null || previousHash.toLowerCase() !== cursor.lastBlockHash.toLowerCase()) {
      const rewoundTo = Math.max(config.chainStartBlock, nextBlock - config.reorgRewindBlocks);
      await prisma.chainCursor.update({
        where: { id: 1 },
        data: { nextBlock: BigInt(rewoundTo), lastBlockHash: null },
      });
      log.error(`deep chain reorg detected; rewound cursor from ${nextBlock} to ${rewoundTo}`);
      return { processed: 0, ignored: 0, rewound: true, scannedThrough: null, sweepDepositAddressIds: [] };
    }
  }
  const head = await provider.getBlockNumber();
  const safeHead = head - config.confirmations;
  if (safeHead < nextBlock) return { processed: 0, ignored: 0, rewound: false, scannedThrough: null, sweepDepositAddressIds: [] };
  const toBlock = Math.min(nextBlock + config.maxBlockRange - 1, safeHead);
  const logs = await provider.getLogs({
    address: config.usdtContractAddress,
    topics: [[transferTopic]],
    fromBlock: nextBlock,
    toBlock,
  });
  const deposits = await matchingDeposits(prisma, logs);
  const external = await systemAccount(prisma, AccountType.EXTERNAL_ONCHAIN, Asset.USDT);
  const vault = await systemAccount(prisma, AccountType.SYSTEM_VAULT_USDT, Asset.USDT);
  const issuance = await systemAccount(prisma, AccountType.SYSTEM_COUPON_ISSUANCE, Asset.COUPON);
  let processed = 0;
  let ignored = 0;
  const sweepDepositAddressIds = new Set<string>();
  for (const chainLog of logs) {
    const transfer = decodeTransfer(chainLog);
    const depositAddress = transfer ? deposits.get(transfer.to.toLowerCase()) : undefined;
    if (!transfer || !depositAddress || transfer.amount <= 0n) {
      ignored += 1;
      continue;
    }
    const userAccount = await prisma.ledgerAccount.findFirstOrThrow({
      where: { type: AccountType.USER_COUPON, asset: Asset.COUPON, userId: depositAddress.userId },
    });
    await postDeposit(prisma, {
      externalRef: `deposit:${chainLog.transactionHash}:${chainLog.index}`,
      userId: depositAddress.userId,
      userCouponAccountId: userAccount.id,
      externalOnchainAccountId: external.id,
      vaultAccountId: vault.id,
      issuanceAccountId: issuance.id,
      amountMicroUsdt: transfer.amount,
      txHash: chainLog.transactionHash,
    });
    await prisma.depositAddress.updateMany({
      where: { id: depositAddress.id, sweepPendingAt: null },
      data: { sweepPendingAt: new Date() },
    });
    sweepDepositAddressIds.add(depositAddress.id);
    processed += 1;
  }
  const blockHash = await provider.getBlockHash(toBlock);
  if (blockHash === null) throw new Error(`chain block ${toBlock} has no hash`);
  await prisma.chainCursor.update({
    where: { id: 1 },
    data: { nextBlock: BigInt(toBlock + 1), lastBlockHash: blockHash },
  });
  return { processed, ignored, rewound: false, scannedThrough: toBlock, sweepDepositAddressIds: [...sweepDepositAddressIds] };
}
