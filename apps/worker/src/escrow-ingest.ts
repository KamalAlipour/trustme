import { Interface, getAddress } from 'ethers';
import { EscrowEventKind, PrismaClient } from '@trustme/db';
import { applyEscrowChainEvent, trustCouponEscrowAbi } from '@trustme/core';
import type { ChainLog, ChainProvider } from './provider.js';

const escrowInterface = new Interface(trustCouponEscrowAbi);
const ESCROW_CURSOR_ID = 2;

export type EscrowIngestConfig = {
  escrowContractAddress?: string | undefined;
  chainStartBlock: number;
  confirmations: number;
  maxBlockRange: number;
  ingestChunksPerTick: number;
  reorgRewindBlocks: number;
};

export async function ingestEscrowOnce(
  prisma: PrismaClient,
  provider: ChainProvider,
  config: EscrowIngestConfig,
  log: Pick<Console, 'warn' | 'error'> = console,
) {
  if (config.escrowContractAddress === undefined) {
    log.warn('escrow ingest disabled: ESCROW_CONTRACT_ADDRESS is not configured');
    return { processed: 0, scannedThrough: null };
  }
  let processed = 0;
  let scannedThrough: number | null = null;
  for (let chunk = 0; chunk < config.ingestChunksPerTick; chunk += 1) {
    const cursor = await prisma.chainCursor.findUnique({ where: { id: ESCROW_CURSOR_ID } }) ??
      await prisma.chainCursor.create({ data: { id: ESCROW_CURSOR_ID, nextBlock: BigInt(config.chainStartBlock) } });
    const nextBlock = Number(cursor.nextBlock);
    if (cursor.lastBlockHash !== null && nextBlock > config.chainStartBlock) {
      const previousHash = await provider.getBlockHash(nextBlock - 1);
      if (previousHash === null || previousHash.toLowerCase() !== cursor.lastBlockHash.toLowerCase()) {
        const rewoundTo = Math.max(config.chainStartBlock, nextBlock - config.reorgRewindBlocks);
        await prisma.chainCursor.update({
          where: { id: ESCROW_CURSOR_ID },
          data: { nextBlock: BigInt(rewoundTo), lastBlockHash: null },
        });
        log.error(`deep escrow chain reorg detected; rewound cursor from ${nextBlock} to ${rewoundTo}`);
        break;
      }
    }
    const head = await provider.getBlockNumber();
    const safeHead = head - config.confirmations;
    if (safeHead < nextBlock) break;
    const toBlock = Math.min(nextBlock + config.maxBlockRange - 1, safeHead);
    const logs = await provider.getLogs({ address: config.escrowContractAddress, topics: [], fromBlock: nextBlock, toBlock });
    for (const chainLog of logs) {
      const parsed = decodeEscrowLog(chainLog);
      if (parsed === null) continue;
      await applyEscrowChainEvent(prisma, {
        ...parsed,
        txHash: chainLog.transactionHash,
        logIndex: chainLog.index,
        blockNumber: BigInt(chainLog.blockNumber),
      });
      processed += 1;
    }
    const hash = await provider.getBlockHash(toBlock);
    if (hash === null) throw new Error(`chain block ${toBlock} has no hash`);
    await prisma.chainCursor.update({ where: { id: ESCROW_CURSOR_ID }, data: { nextBlock: BigInt(toBlock + 1), lastBlockHash: hash } });
    scannedThrough = toBlock;
    if (toBlock < safeHead) continue;
    break;
  }
  return { processed, scannedThrough };
}

export function decodeEscrowLog(log: ChainLog): {
  kind: EscrowEventKind;
  walletAddress: string;
  amountMicroUsdt: bigint;
  ref?: string;
} | null {
  try {
    const parsed = escrowInterface.parseLog({ topics: log.topics, data: log.data });
    if (parsed === null) return null;
    if (parsed.name === 'Deposited') return { kind: EscrowEventKind.DEPOSIT, walletAddress: getAddress(String(parsed.args[0])), amountMicroUsdt: BigInt(parsed.args[1]) };
    if (parsed.name === 'Settled') return { kind: EscrowEventKind.SETTLE, walletAddress: getAddress(String(parsed.args[0])), amountMicroUsdt: BigInt(parsed.args[1]), ref: String(parsed.args[2]) };
    if (parsed.name === 'Unloaded') return { kind: EscrowEventKind.UNLOAD, walletAddress: getAddress(String(parsed.args[0])), amountMicroUsdt: BigInt(parsed.args[2]), ref: String(parsed.args[3]) };
    return null;
  } catch {
    return null;
  }
}
