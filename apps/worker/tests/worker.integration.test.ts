import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HDNodeWallet, id, Interface, Transaction, zeroPadValue, getAddress } from 'ethers';
import { AccountType, Asset, DepositSweepStatus, PrismaClient, WithdrawalStatus } from '@trustme/db';
import { createPayCode, postDeposit, readDemoCirculation, requestUnload, requestWithdrawal, settleWithPayCode, trustCouponEscrowAbi } from '@trustme/core';
import { decodeEscrowLog } from '../src/escrow-ingest.js';
import { churnDemoCoupons } from '../src/demo-churn.js';
import { confirmWithdrawal, dispatchWithdrawal } from '../src/dispatch.js';
import { dispatchEscrowSettlement, dispatchEscrowUnload } from '../src/escrow-dispatch.js';
import { ingestOnce } from '../src/ingest.js';
import { loadDepositAccountNode } from '../src/index.js';
import { FakeChainProvider, FakeTransactionSigner } from '../src/provider.js';
import { fundSweepGas, sweepDepositAddress } from '../src/sweep.js';
import { loadWorkerConfig } from '../src/config.js';
import type { WorkerConfig } from '../src/config.js';

const prisma = new PrismaClient();
const usdt = getAddress(`0x${'aa'.repeat(20)}`);
const transferTopic = id('Transfer(address,address,uint256)');
const dispatchConfig = {
  usdtContractAddress: usdt,
  chainId: 137,
  confirmations: 2,
  gasSafetyMultiplierBps: 12_500,
  gasLimitCeiling: 200_000,
};
const sweepConfig = {
  ...dispatchConfig,
  hotWalletAddress: getAddress(`0x${'dd'.repeat(20)}`),
  sweepMinMicroUsdt: 1_000_000,
  sweepMaxGasTopUpWei: 500_000_000_000_000_000n,
  sweepFailureBackoffMs: 900_000,
  sweepMaxAttempts: 5,
};

async function account(type: AccountType, asset: Asset, userId?: string) {
  return prisma.ledgerAccount.create({ data: { type, asset, ...(userId === undefined ? {} : { userId }) } });
}

async function fixture() {
  const user = await prisma.user.create({ data: { phoneNumber: '+1555000999', barcodeId: 'worker-user', identityVerificationStatus: 'VERIFIED', identityVerifiedAt: new Date() } });
  const userAccount = await account(AccountType.USER_COUPON, Asset.COUPON, user.id);
  const depositAddress = await prisma.depositAddress.create({
    data: { userId: user.id, address: getAddress(`0x${'bb'.repeat(20)}`) },
  });
  const external = await account(AccountType.EXTERNAL_ONCHAIN, Asset.USDT);
  const vault = await account(AccountType.SYSTEM_VAULT_USDT, Asset.USDT);
  const pending = await account(AccountType.SYSTEM_WITHDRAWAL_PENDING, Asset.USDT);
  const fees = await account(AccountType.SYSTEM_FEE_COLLECTION, Asset.USDT);
  const issuance = await account(AccountType.SYSTEM_COUPON_ISSUANCE, Asset.COUPON);
  const onchainLog = {
    address: usdt,
    topics: [transferTopic, zeroPadValue('0x01', 32), zeroPadValue(depositAddress.address, 32)],
    data: '0x' + 1_000_000_000n.toString(16).padStart(64, '0'),
    blockNumber: 100,
    transactionHash: '0x' + '12'.repeat(32),
    index: 0,
  };
  return { user, userAccount, depositAddress, external, vault, pending, fees, issuance, onchainLog };
}

async function sweepFixture() {
  const user = await prisma.user.create({ data: { phoneNumber: '+1555000888', barcodeId: `sweep-${Date.now()}-${Math.random()}` } });
  const accountNode = HDNodeWallet.createRandom();
  const depositAddress = await prisma.depositAddress.create({
    data: { userId: user.id, address: `pending:${user.id}`, sweepPendingAt: new Date() },
  });
  const derived = accountNode.deriveChild(depositAddress.derivationIndex);
  const updatedAddress = await prisma.depositAddress.update({
    where: { id: depositAddress.id },
    data: { address: derived.address },
  });
  return { user, accountNode, depositAddress: updatedAddress, derived };
}

async function withMnemonicFile<T>(contents: string, run: (filePath: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'trustme-worker-'));
  const filePath = join(directory, 'mnemonic.txt');
  await writeFile(filePath, contents, 'utf8');
  try {
    return await run(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

class TransientSweepProvider extends FakeChainProvider {
  public failEstimateFees = true;

  public override async estimateFees() {
    if (this.failEstimateFees) throw new Error('temporary RPC failure');
    return super.estimateFees();
  }
}

class TransientEscrowProvider extends FakeChainProvider {
  public failEstimateFees = true;

  public override async estimateFees() {
    if (this.failEstimateFees) throw new Error('temporary escrow RPC failure');
    return super.estimateFees();
  }
}

beforeAll(async () => {
  await prisma.$connect();
});
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "EscrowChainEvent", "EscrowUnload", "EscrowSettlement", "PayCode", "EscrowBalance", "MemberWallet", "MediaAsset", "RefundRequest", "AidRequest", "CharityAgent", "Charity", "AdminAuditLog", "AdminUser", "Withdrawal", "DepositSweep", "EscrowHold", "EmailVerification", "MemberDevice", "Contact", "LoanInstallment", "Guarantee", "Loan", "LedgerEntry", "Transaction", "LedgerAccount", "DepositAddress", "User", "ChainCursor" CASCADE');
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('chain ingest', () => {
  it('decodes escrow event logs', () => {
    const iface = new Interface(trustCouponEscrowAbi);
    const event = iface.getEvent('Deposited');
    if (event === null) throw new Error('missing Deposited event');
    const encoded = iface.encodeEventLog(event, ['0x0000000000000000000000000000000000000001', 123n, 123n]);
    const decoded = decodeEscrowLog({
      address: '0x0000000000000000000000000000000000000002',
      topics: encoded.topics,
      data: encoded.data,
      blockNumber: 1,
      transactionHash: '0xabc',
      index: 0,
    });
    expect(decoded?.amountMicroUsdt).toBe(123n);
    expect(decoded?.walletAddress).toBe('0x0000000000000000000000000000000000000001');
  });
  it('processes confirmed deposits and replays idempotently', async () => {
    const fixtureAccounts = await fixture();
    const provider = new FakeChainProvider({
      head: 112,
      blockHashes: new Map([[100, '0x100'], [101, '0x101'], [102, '0x102'], [103, '0x103']]),
      logs: [fixtureAccounts.onchainLog],
    });
    const config = { usdtContractAddress: usdt, chainStartBlock: 100, confirmations: 12, maxBlockRange: 2_000, ingestChunksPerTick: 20, reorgRewindBlocks: 64 };
    await expect(ingestOnce(prisma, provider, config)).resolves.toMatchObject({ processed: 1, scannedThrough: 100 });
    expect((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: fixtureAccounts.userAccount.id } })).balance).toBe(100_000n);
    await prisma.chainCursor.update({ where: { id: 1 }, data: { nextBlock: 100n, lastBlockHash: null } });
    await expect(ingestOnce(prisma, provider, config)).resolves.toMatchObject({ processed: 1 });
    expect(await prisma.transaction.count({ where: { externalRef: `deposit:${fixtureAccounts.onchainLog.transactionHash}:0` } })).toBe(1);
    expect((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: fixtureAccounts.userAccount.id } })).balance).toBe(100_000n);
  });

  it('ignores unknown destinations and blocks in the confirmation buffer', async () => {
    const fixtureAccounts = await fixture();
    const unknown = { ...fixtureAccounts.onchainLog, topics: [transferTopic, zeroPadValue('0x01', 32), zeroPadValue(`0x${'cc'.repeat(20)}`, 32)] };
    const provider = new FakeChainProvider({
      head: 101,
      blockHashes: new Map([[100, '0x100']]),
      logs: [unknown, fixtureAccounts.onchainLog],
    });
    const config = { usdtContractAddress: usdt, chainStartBlock: 100, confirmations: 12, maxBlockRange: 2_000, ingestChunksPerTick: 20, reorgRewindBlocks: 64 };
    await expect(ingestOnce(prisma, provider, config)).resolves.toMatchObject({ scannedThrough: null, processed: 0 });
    expect(await prisma.transaction.count()).toBe(0);
  });

  it('rewinds on a previous-block hash mismatch', async () => {
    const fixtureAccounts = await fixture();
    const config = { usdtContractAddress: usdt, chainStartBlock: 100, confirmations: 1, maxBlockRange: 10, ingestChunksPerTick: 20, reorgRewindBlocks: 64 };
    await prisma.chainCursor.create({ data: { id: 1, nextBlock: 150n, lastBlockHash: '0xold' } });
    const provider = new FakeChainProvider({ head: 200, blockHashes: new Map([[149, '0xnew']]), logs: [fixtureAccounts.onchainLog] });
    await expect(ingestOnce(prisma, provider, config)).resolves.toMatchObject({ rewound: true });
    expect(await prisma.chainCursor.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ nextBlock: 100n, lastBlockHash: null });
  });

  it('scans multiple confirmed chunks in one tick', async () => {
    const fixtureAccounts = await fixture();
    const provider = new FakeChainProvider({
      head: 130,
      blockHashes: new Map([[109, '0x109'], [119, '0x119'], [129, '0x129']]),
      logs: [fixtureAccounts.onchainLog],
    });
    const config = { usdtContractAddress: usdt, chainStartBlock: 100, confirmations: 1, maxBlockRange: 10, ingestChunksPerTick: 3, reorgRewindBlocks: 64 };

    await expect(ingestOnce(prisma, provider, config)).resolves.toMatchObject({ processed: 1, scannedThrough: 129 });
    expect(await prisma.chainCursor.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ nextBlock: 130n, lastBlockHash: '0x129' });
  });

  it('honors the per-tick chunk cap', async () => {
    await fixture();
    const provider = new FakeChainProvider({
      head: 500,
      blockHashes: new Map([[109, '0x109'], [119, '0x119']]),
    });
    const config = { usdtContractAddress: usdt, chainStartBlock: 100, confirmations: 1, maxBlockRange: 10, ingestChunksPerTick: 2, reorgRewindBlocks: 64 };

    await expect(ingestOnce(prisma, provider, config)).resolves.toMatchObject({ scannedThrough: 119 });
    expect(await prisma.chainCursor.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ nextBlock: 120n, lastBlockHash: '0x119' });
  });

  it('stops scanning after a reorg rewind', async () => {
    await fixture();
    class ReorgAfterFirstChunkProvider extends FakeChainProvider {
      private hashReads = 0;
      public logReads = 0;

      public override async getBlockHash(blockNumber: number): Promise<string | null> {
        if (blockNumber === 109) {
          this.hashReads += 1;
          return this.hashReads === 1 ? '0x109' : '0xreorg';
        }
        return super.getBlockHash(blockNumber);
      }

      public override async getLogs(filter: Parameters<FakeChainProvider['getLogs']>[0]) {
        this.logReads += 1;
        return super.getLogs(filter);
      }
    }
    const provider = new ReorgAfterFirstChunkProvider({
      head: 200,
      blockHashes: new Map([[109, '0x109']]),
    });
    const config = { usdtContractAddress: usdt, chainStartBlock: 100, confirmations: 1, maxBlockRange: 10, ingestChunksPerTick: 5, reorgRewindBlocks: 64 };

    await expect(ingestOnce(prisma, provider, config)).resolves.toMatchObject({ rewound: true, scannedThrough: 109 });
    expect(provider.logReads).toBe(1);
    expect(await prisma.chainCursor.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ nextBlock: 100n, lastBlockHash: null });
  });
});

describe('escrow dispatch', () => {
  it('retries transient settlement and unload provider failures without failing rows', async () => {
    const buyer = await prisma.user.create({ data: { phoneNumber: '+1555000777', barcodeId: 'escrow-worker-buyer' } });
    const merchant = await prisma.user.create({ data: { phoneNumber: '+1555000778', barcodeId: 'escrow-worker-merchant' } });
    await account(AccountType.USER_COUPON, Asset.COUPON, buyer.id);
    await account(AccountType.USER_COUPON, Asset.COUPON, merchant.id);
    await account(AccountType.SYSTEM_COUPON_ISSUANCE, Asset.COUPON);
    await prisma.memberWallet.create({ data: { userId: buyer.id, address: getAddress(`0x${'01'.repeat(20)}`), kind: 'EXTERNAL', chainId: 137 } });
    await prisma.escrowBalance.create({ data: { userId: buyer.id, lockedMicroUsdt: 2_000_000n } });
    await createPayCode(prisma, { buyerId: buyer.id, code: '1234', maxAmountMicroUsdt: 1_000_000n, expiresAt: new Date(Date.now() + 60_000) });
    const settlement = await settleWithPayCode(prisma, { merchantId: merchant.id, buyerBarcodeId: buyer.barcodeId, code: '1234', amountMicroUsdt: 500_000n });
    const signer = new FakeTransactionSigner(getAddress(`0x${'02'.repeat(20)}`), '0x02');
    const provider = new TransientEscrowProvider({ head: 1 });
    const escrowConfig = { ...dispatchConfig, escrowContractAddress: getAddress(`0x${'03'.repeat(20)}`), escrowSettlerKey: 'test-key', escrowMaxAttempts: 5 };
    await expect(dispatchEscrowSettlement(prisma, provider, signer, escrowConfig, settlement.settlement.id)).rejects.toThrow('temporary escrow RPC failure');
    expect(await prisma.escrowSettlement.findUniqueOrThrow({ where: { id: settlement.settlement.id } })).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'temporary escrow RPC failure' });
    provider.failEstimateFees = false;
    await expect(dispatchEscrowSettlement(prisma, provider, signer, escrowConfig, settlement.settlement.id)).resolves.toMatchObject({ status: 'broadcast' });
    const unload = await requestUnload(prisma, { userId: buyer.id, amountMicroUsdt: 250_000n });
    provider.failEstimateFees = true;
    await expect(dispatchEscrowUnload(prisma, provider, signer, escrowConfig, unload.id)).rejects.toThrow('temporary escrow RPC failure');
    expect(await prisma.escrowUnload.findUniqueOrThrow({ where: { id: unload.id } })).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'temporary escrow RPC failure' });
  });
});

describe('deposit sweep', () => {
  it('clears the pending marker and leaves below-threshold dust in place', async () => {
    const fixtureAccounts = await sweepFixture();
    const provider = new FakeChainProvider({
      tokenBalances: new Map([[`${usdt.toLowerCase()}:${fixtureAccounts.derived.address.toLowerCase()}`, 999_999n]]),
    });

    await expect(sweepDepositAddress(prisma, provider, fixtureAccounts.accountNode, sweepConfig, fixtureAccounts.depositAddress.id))
      .resolves.toMatchObject({ status: 'skipped' });
    expect(await prisma.depositAddress.findUniqueOrThrow({ where: { id: fixtureAccounts.depositAddress.id } })).toMatchObject({ sweepPendingAt: null });
    expect(await prisma.depositSweep.count()).toBe(0);
    expect(provider.sentTransactions).toHaveLength(0);
  });

  it('sweeps the full current USDT balance to the hot wallet', async () => {
    const fixtureAccounts = await sweepFixture();
    const balance = 12_345_678n;
    const provider = new FakeChainProvider({
      tokenBalances: new Map([[`${usdt.toLowerCase()}:${fixtureAccounts.derived.address.toLowerCase()}`, balance]]),
      nativeBalances: new Map([[fixtureAccounts.derived.address.toLowerCase(), 1_000_000_000_000_000_000n]]),
      pendingNonce: 7,
    });

    await expect(sweepDepositAddress(prisma, provider, fixtureAccounts.accountNode, sweepConfig, fixtureAccounts.depositAddress.id))
      .resolves.toMatchObject({ status: 'broadcast' });
    expect(provider.sentTransactions).toHaveLength(1);
    const transaction = Transaction.from(provider.sentTransactions[0]);
    expect(transaction.from).toBe(fixtureAccounts.derived.address);
    expect(transaction.to).toBe(usdt);
    expect(transaction.nonce).toBe(7);
    expect(transaction.data).toContain(balance.toString(16));
    expect((await prisma.depositSweep.findFirstOrThrow()).amountMicroUsdt).toBe(balance);
  });

  it('funds native gas through the hot wallet before signing the deposit transfer', async () => {
    const fixtureAccounts = await sweepFixture();
    const balance = 5_000_000n;
    const receipts = new Map();
    const nativeBalances = new Map<string, bigint>([
      [fixtureAccounts.derived.address.toLowerCase(), 0n],
      [sweepConfig.hotWalletAddress.toLowerCase(), 1_000_000_000_000_000_000n],
    ]);
    const provider = new FakeChainProvider({
      tokenBalances: new Map([[`${usdt.toLowerCase()}:${fixtureAccounts.derived.address.toLowerCase()}`, balance]]),
      nativeBalances,
      receipts,
    });
    const hotSigner = new FakeTransactionSigner(sweepConfig.hotWalletAddress, '0x02');

    const pending = await sweepDepositAddress(prisma, provider, fixtureAccounts.accountNode, sweepConfig, fixtureAccounts.depositAddress.id);
    expect(pending).toMatchObject({ status: 'gas-funding' });
    const sweep = await prisma.depositSweep.findFirstOrThrow();
    const gas = await fundSweepGas(prisma, provider, fixtureAccounts.accountNode, hotSigner, sweepConfig, sweep.id);
    expect(gas.status).toBe('broadcast');
    expect(hotSigner.signCount).toBe(1);
    expect(provider.sentTransactions).toHaveLength(1);

    receipts.set(gas.status === 'broadcast' ? gas.txHash : '', { status: 1, blockNumber: 1, transactionHash: gas.status === 'broadcast' ? gas.txHash : '' });
    nativeBalances.set(fixtureAccounts.derived.address.toLowerCase(), 1_000_000_000_000_000_000n);
    const resumed = await sweepDepositAddress(prisma, provider, fixtureAccounts.accountNode, sweepConfig, fixtureAccounts.depositAddress.id);
    expect(resumed.status).toBe('broadcast');
    expect(hotSigner.signCount).toBe(1);
    expect(provider.sentTransactions).toHaveLength(2);
    expect(Transaction.from(provider.sentTransactions[1]).from).toBe(fixtureAccounts.derived.address);
  });

  it('fails an excessive gas shortfall without signing', async () => {
    const fixtureAccounts = await sweepFixture();
    const provider = new FakeChainProvider({
      tokenBalances: new Map([[`${usdt.toLowerCase()}:${fixtureAccounts.derived.address.toLowerCase()}`, 5_000_000n]]),
      nativeBalances: new Map([[fixtureAccounts.derived.address.toLowerCase(), 0n]]),
    });
    const config = { ...sweepConfig, sweepMaxGasTopUpWei: 1n };

    await expect(sweepDepositAddress(prisma, provider, fixtureAccounts.accountNode, config, fixtureAccounts.depositAddress.id))
      .resolves.toMatchObject({ status: 'failed' });
    expect(await prisma.depositSweep.findFirstOrThrow()).toMatchObject({ status: DepositSweepStatus.FAILED });
    expect(provider.sentTransactions).toHaveLength(0);
  });

  it('fails a derived-address mismatch without signing', async () => {
    const fixtureAccounts = await sweepFixture();
    const wrongNode = HDNodeWallet.createRandom();
    const provider = new FakeChainProvider({
      tokenBalances: new Map([[`${usdt.toLowerCase()}:${fixtureAccounts.depositAddress.address.toLowerCase()}`, 5_000_000n]]),
    });

    await expect(sweepDepositAddress(prisma, provider, wrongNode, sweepConfig, fixtureAccounts.depositAddress.id))
      .resolves.toMatchObject({ status: 'failed' });
    expect(await prisma.depositSweep.findFirstOrThrow()).toMatchObject({ status: DepositSweepStatus.FAILED, lastError: 'deposit address derivation mismatch' });
    expect(provider.sentTransactions).toHaveLength(0);
  });

  it('leaves a PENDING sweep retryable after a transient RPC failure', async () => {
    const fixtureAccounts = await sweepFixture();
    const provider = new TransientSweepProvider({
      tokenBalances: new Map([[`${usdt.toLowerCase()}:${fixtureAccounts.derived.address.toLowerCase()}`, 5_000_000n]]),
    });

    await expect(sweepDepositAddress(prisma, provider, fixtureAccounts.accountNode, sweepConfig, fixtureAccounts.depositAddress.id))
      .rejects.toThrow('temporary RPC failure');
    const firstSweep = await prisma.depositSweep.findFirstOrThrow();
    expect(firstSweep).toMatchObject({ status: DepositSweepStatus.PENDING });
    expect((await prisma.depositAddress.findUniqueOrThrow({ where: { id: fixtureAccounts.depositAddress.id } })).sweepPendingAt).not.toBeNull();
    provider.failEstimateFees = false;
    await expect(sweepDepositAddress(prisma, provider, fixtureAccounts.accountNode, sweepConfig, fixtureAccounts.depositAddress.id))
      .resolves.toMatchObject({ status: 'broadcast', sweepId: firstSweep.id });
    expect(await prisma.depositSweep.count()).toBe(1);
  });

  it('does not create a replacement for a recent failed sweep', async () => {
    const fixtureAccounts = await sweepFixture();
    await prisma.depositSweep.create({
      data: {
        depositAddressId: fixtureAccounts.depositAddress.id,
        amountMicroUsdt: 5_000_000n,
        status: DepositSweepStatus.FAILED,
        lastError: 'permanent failure',
      },
    });
    const provider = new FakeChainProvider({
      tokenBalances: new Map([[`${usdt.toLowerCase()}:${fixtureAccounts.derived.address.toLowerCase()}`, 5_000_000n]]),
    });

    await expect(sweepDepositAddress(prisma, provider, fixtureAccounts.accountNode, sweepConfig, fixtureAccounts.depositAddress.id))
      .resolves.toMatchObject({ status: 'skipped' });
    expect(await prisma.depositSweep.count()).toBe(1);
    expect(provider.sentTransactions).toHaveLength(0);
  });

  it('clears the pending marker after consecutive failures reach the limit', async () => {
    const fixtureAccounts = await sweepFixture();
    await prisma.depositSweep.createMany({
      data: Array.from({ length: sweepConfig.sweepMaxAttempts }, () => ({
        depositAddressId: fixtureAccounts.depositAddress.id,
        amountMicroUsdt: 5_000_000n,
        status: DepositSweepStatus.FAILED,
        lastError: 'permanent failure',
      })),
    });
    const provider = new FakeChainProvider();

    await expect(sweepDepositAddress(prisma, provider, fixtureAccounts.accountNode, sweepConfig, fixtureAccounts.depositAddress.id))
      .resolves.toMatchObject({ status: 'skipped' });
    expect(await prisma.depositSweep.count()).toBe(sweepConfig.sweepMaxAttempts);
    expect((await prisma.depositAddress.findUniqueOrThrow({ where: { id: fixtureAccounts.depositAddress.id } })).sweepPendingAt).toBeNull();
  });

  it('allows a second gas top-up when the first mined top-up is still insufficient', async () => {
    const fixtureAccounts = await sweepFixture();
    const receipts = new Map();
    const nativeBalances = new Map<string, bigint>([
      [fixtureAccounts.derived.address.toLowerCase(), 0n],
      [sweepConfig.hotWalletAddress.toLowerCase(), 1_000_000_000_000_000_000n],
    ]);
    const provider = new FakeChainProvider({
      tokenBalances: new Map([[`${usdt.toLowerCase()}:${fixtureAccounts.derived.address.toLowerCase()}`, 5_000_000n]]),
      nativeBalances,
      receipts,
    });
    const hotSigner = new FakeTransactionSigner(sweepConfig.hotWalletAddress, '0x02');

    await expect(sweepDepositAddress(prisma, provider, fixtureAccounts.accountNode, sweepConfig, fixtureAccounts.depositAddress.id))
      .resolves.toMatchObject({ status: 'gas-funding' });
    let sweep = await prisma.depositSweep.findFirstOrThrow();
    const firstTopUp = await fundSweepGas(prisma, provider, fixtureAccounts.accountNode, hotSigner, sweepConfig, sweep.id);
    if (firstTopUp.status !== 'broadcast') throw new Error('expected first gas top-up broadcast');
    receipts.set(firstTopUp.txHash, { status: 1, blockNumber: 1, transactionHash: firstTopUp.txHash });

    await expect(sweepDepositAddress(prisma, provider, fixtureAccounts.accountNode, sweepConfig, fixtureAccounts.depositAddress.id))
      .resolves.toMatchObject({ status: 'gas-funding' });
    sweep = await prisma.depositSweep.findFirstOrThrow();
    expect(sweep.status).toBe(DepositSweepStatus.GAS_FUNDING);
    expect(sweep.gasTxHash).toBeNull();
    const secondTopUp = await fundSweepGas(prisma, provider, fixtureAccounts.accountNode, hotSigner, sweepConfig, sweep.id);
    expect(secondTopUp.status).toBe('broadcast');
    expect(hotSigner.signCount).toBe(2);
    expect(provider.sentTransactions).toHaveLength(2);
  });

  it('does not double-broadcast a sweep already marked BROADCAST', async () => {
    const fixtureAccounts = await sweepFixture();
    const provider = new FakeChainProvider({
      tokenBalances: new Map([[`${usdt.toLowerCase()}:${fixtureAccounts.derived.address.toLowerCase()}`, 5_000_000n]]),
      nativeBalances: new Map([[fixtureAccounts.derived.address.toLowerCase(), 1_000_000_000_000_000_000n]]),
    });

    await sweepDepositAddress(prisma, provider, fixtureAccounts.accountNode, sweepConfig, fixtureAccounts.depositAddress.id);
    await expect(sweepDepositAddress(prisma, provider, fixtureAccounts.accountNode, sweepConfig, fixtureAccounts.depositAddress.id))
      .resolves.toMatchObject({ status: 'waiting' });
    expect(provider.sentTransactions).toHaveLength(1);
  });

  it('confirms a sweep and clears its pending marker after enough blocks', async () => {
    const fixtureAccounts = await sweepFixture();
    const receipts = new Map();
    const provider = new FakeChainProvider({
      head: 100,
      tokenBalances: new Map([[`${usdt.toLowerCase()}:${fixtureAccounts.derived.address.toLowerCase()}`, 5_000_000n]]),
      nativeBalances: new Map([[fixtureAccounts.derived.address.toLowerCase(), 1_000_000_000_000_000_000n]]),
      receipts,
    });

    const first = await sweepDepositAddress(prisma, provider, fixtureAccounts.accountNode, sweepConfig, fixtureAccounts.depositAddress.id);
    if (first.status !== 'broadcast') throw new Error('expected sweep broadcast');
    receipts.set(first.txHash, { status: 1, blockNumber: 99, transactionHash: first.txHash });
    await expect(sweepDepositAddress(prisma, provider, fixtureAccounts.accountNode, sweepConfig, fixtureAccounts.depositAddress.id))
      .resolves.toMatchObject({ status: 'confirmed' });
    expect(await prisma.depositSweep.findFirstOrThrow()).toMatchObject({ status: DepositSweepStatus.CONFIRMED, confirmedAt: expect.any(Date) });
    expect(await prisma.depositAddress.findUniqueOrThrow({ where: { id: fixtureAccounts.depositAddress.id } })).toMatchObject({ sweepPendingAt: null });
  });

  it('leaves the pending marker set when the sweep receipt fails', async () => {
    const fixtureAccounts = await sweepFixture();
    const receipts = new Map();
    const provider = new FakeChainProvider({
      head: 100,
      tokenBalances: new Map([[`${usdt.toLowerCase()}:${fixtureAccounts.derived.address.toLowerCase()}`, 5_000_000n]]),
      nativeBalances: new Map([[fixtureAccounts.derived.address.toLowerCase(), 1_000_000_000_000_000_000n]]),
      receipts,
    });

    const first = await sweepDepositAddress(prisma, provider, fixtureAccounts.accountNode, sweepConfig, fixtureAccounts.depositAddress.id);
    if (first.status !== 'broadcast') throw new Error('expected sweep broadcast');
    receipts.set(first.txHash, { status: 0, blockNumber: 99, transactionHash: first.txHash });
    await expect(sweepDepositAddress(prisma, provider, fixtureAccounts.accountNode, sweepConfig, fixtureAccounts.depositAddress.id))
      .resolves.toMatchObject({ status: 'failed' });
    expect(await prisma.depositSweep.findFirstOrThrow()).toMatchObject({ status: DepositSweepStatus.FAILED });
    expect((await prisma.depositAddress.findUniqueOrThrow({ where: { id: fixtureAccounts.depositAddress.id } })).sweepPendingAt).not.toBeNull();
  });

  it('disables sweeping when the mnemonic file is unavailable', async () => {
    const wallet = HDNodeWallet.createRandom();
    const config = {
      databaseUrl: 'postgresql://localhost/trustme',
      redisUrl: 'redis://localhost',
      polygonRpcUrl: 'http://127.0.0.1:8545',
      usdtContractAddress: usdt,
      hotWalletPrivateKey: HDNodeWallet.createRandom().privateKey,
      depositWalletMnemonicPath: '/definitely/missing/trustme-deposit-wallet.txt',
      depositDerivationPath: "m/44'/60'/0'/0",
      depositXpub: wallet.neuter().extendedKey,
    } as WorkerConfig;
    const warnings: string[] = [];

    await expect(loadDepositAccountNode(config, { warn: (message) => warnings.push(message) })).resolves.toBeNull();
    expect(warnings).toEqual(['deposit sweeping disabled: deposit wallet mnemonic is unavailable']);
  });

  it('loads a mnemonic-derived xpub from a configured non-default path', async () => {
    const generated = HDNodeWallet.createRandom();
    const phrase = generated.mnemonic?.phrase;
    if (phrase === undefined) throw new Error('generated wallet did not include a mnemonic');
    const derivationPath = "m/44'/60'/0'/0/0/44'/60'/0'/0";
    const accountNode = HDNodeWallet.fromPhrase(phrase, undefined, derivationPath);
    const config = {
      depositWalletMnemonicPath: '',
      depositDerivationPath: derivationPath,
      depositXpub: accountNode.neuter().extendedKey,
    } as WorkerConfig;

    await withMnemonicFile(`# generated for this test\n\n${phrase}\n`, async (filePath) => {
      config.depositWalletMnemonicPath = filePath;
      await expect(loadDepositAccountNode(config, { warn: () => undefined }))
        .resolves.toMatchObject({ depth: 9, address: accountNode.address });
    });
  });

  it('ignores comments and blank lines in the mnemonic file', async () => {
    const generated = HDNodeWallet.createRandom();
    const phrase = generated.mnemonic?.phrase;
    if (phrase === undefined) throw new Error('generated wallet did not include a mnemonic');
    const derivationPath = "m/44'/60'/0'/0";
    const accountNode = HDNodeWallet.fromPhrase(phrase, undefined, derivationPath);
    const config = {
      depositWalletMnemonicPath: '',
      depositDerivationPath: derivationPath,
      depositXpub: accountNode.neuter().extendedKey,
    } as WorkerConfig;

    await withMnemonicFile(`  # first header\n\n# second header\n ${phrase} \n`, async (filePath) => {
      config.depositWalletMnemonicPath = filePath;
      await expect(loadDepositAccountNode(config, { warn: () => undefined }))
        .resolves.toMatchObject({ address: accountNode.address });
    });
  });

  it('rejects a derivation path and xpub mismatch with an actionable error', async () => {
    const generated = HDNodeWallet.createRandom();
    const phrase = generated.mnemonic?.phrase;
    if (phrase === undefined) throw new Error('generated wallet did not include a mnemonic');
    const derivationPath = "m/44'/60'/0'/0/0/44'/60'/0'/0";
    const configuredPath = "m/44'/60'/0'/0";
    const wrongAccountNode = HDNodeWallet.fromPhrase(phrase, undefined, configuredPath);
    const config = {
      depositWalletMnemonicPath: '',
      depositDerivationPath: derivationPath,
      depositXpub: wrongAccountNode.neuter().extendedKey,
    } as WorkerConfig;

    await withMnemonicFile(phrase, async (filePath) => {
      config.depositWalletMnemonicPath = filePath;
      await expect(loadDepositAccountNode(config, { warn: () => undefined }))
        .rejects.toThrow(`deposit wallet xpub does not match configured derivation path ${derivationPath}`);
    });
  });
});

describe('withdrawal dispatch and confirmation', () => {
  it('persists the hash before broadcasting and settles exactly once', async () => {
    const fixtureAccounts = await fixture();
    await postDeposit(prisma, {
      externalRef: 'deposit:dispatch:0',
      userId: fixtureAccounts.user.id,
      userCouponAccountId: fixtureAccounts.userAccount.id,
      externalOnchainAccountId: fixtureAccounts.external.id,
      vaultAccountId: fixtureAccounts.vault.id,
      issuanceAccountId: fixtureAccounts.issuance.id,
      amountMicroUsdt: 2_000_000_000n,
    });
    const withdrawal = await requestWithdrawal(prisma, {
      userId: fixtureAccounts.user.id,
      userAccountId: fixtureAccounts.userAccount.id,
      destinationAddress: getAddress(`0x${'cc'.repeat(20)}`),
      couponsGross: 50_000n,
      baseFeeBps: 100n,
      minimumFeeMicroUsdt: 0n,
      minimumWithdrawalMicroUsdt: 1n,
      autoApprovalLimitMicroUsdt: 1_000_000_000n,
      vaultAccountId: fixtureAccounts.vault.id,
      feeAccountId: fixtureAccounts.fees.id,
      pendingAccountId: fixtureAccounts.pending.id,
      issuanceAccountId: fixtureAccounts.issuance.id,
      cooldownHours: 0,
    });
    const signer = new FakeTransactionSigner(getAddress(`0x${'dd'.repeat(20)}`), '0x01');
    const provider = new FakeChainProvider({
      pendingNonce: 8,
      latestNonce: 7,
      gasEstimate: 40_000n,
      onSendTransaction: async () => {
        expect((await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } })).chainTxHash).not.toBeNull();
      },
    });
    const result = await dispatchWithdrawal(prisma, provider, signer, dispatchConfig, withdrawal.id);
    expect(result.status).toBe('broadcast');
    expect(signer.signCount).toBe(1);
    expect(signer.signedRequests[0]).toMatchObject({ chainId: 137, type: 0, nonce: 8, gasLimit: 50_000n });
    const hash = (await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } })).chainTxHash;
    expect(hash).not.toBeNull();
    const receiptProvider = new FakeChainProvider({
      head: 100,
      receipts: new Map([[hash!, { status: 1, blockNumber: 99, transactionHash: hash! }]]),
    });
    await expect(confirmWithdrawal(prisma, receiptProvider, dispatchConfig, withdrawal.id)).resolves.toMatchObject({ status: 'completed' });
    await expect(confirmWithdrawal(prisma, receiptProvider, dispatchConfig, withdrawal.id)).resolves.toMatchObject({ status: 'completed' });
    expect(await prisma.transaction.count({ where: { externalRef: `withdrawal:${withdrawal.id}:settle` } })).toBe(1);
  });

  it('resumes a hashed withdrawal without signing again and does not refund reverts', async () => {
    const fixtureAccounts = await fixture();
    await postDeposit(prisma, {
      externalRef: 'deposit:dispatch:1',
      userId: fixtureAccounts.user.id,
      userCouponAccountId: fixtureAccounts.userAccount.id,
      externalOnchainAccountId: fixtureAccounts.external.id,
      vaultAccountId: fixtureAccounts.vault.id,
      issuanceAccountId: fixtureAccounts.issuance.id,
      amountMicroUsdt: 2_000_000_000n,
    });
    const withdrawal = await requestWithdrawal(prisma, {
      userId: fixtureAccounts.user.id,
      userAccountId: fixtureAccounts.userAccount.id,
      destinationAddress: getAddress(`0x${'cc'.repeat(20)}`),
      couponsGross: 50_000n,
      baseFeeBps: 100n,
      minimumFeeMicroUsdt: 0n,
      minimumWithdrawalMicroUsdt: 1n,
      autoApprovalLimitMicroUsdt: 1_000_000_000n,
      vaultAccountId: fixtureAccounts.vault.id,
      feeAccountId: fixtureAccounts.fees.id,
      pendingAccountId: fixtureAccounts.pending.id,
      issuanceAccountId: fixtureAccounts.issuance.id,
      cooldownHours: 0,
    });
    const signer = new FakeTransactionSigner(getAddress(`0x${'dd'.repeat(20)}`), '0x01');
    const provider = new FakeChainProvider();
    await dispatchWithdrawal(prisma, provider, signer, dispatchConfig, withdrawal.id);
    const before = await prisma.ledgerEntry.count();
    expect((await dispatchWithdrawal(prisma, provider, signer, dispatchConfig, withdrawal.id)).status).toBe('watching');
    expect(signer.signCount).toBe(1);
    const hashed = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } });
    const reverted = new FakeChainProvider({ head: 100, receipts: new Map([[hashed.chainTxHash!, { status: 0, blockNumber: 99, transactionHash: hashed.chainTxHash! }]]) });
    await expect(confirmWithdrawal(prisma, reverted, dispatchConfig, withdrawal.id)).resolves.toMatchObject({ status: 'failed' });
    expect(await prisma.ledgerEntry.count()).toBe(before);
    expect((await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } })).status).toBe(WithdrawalStatus.FAILED);
  });

  it('returns a pre-broadcast signing failure to APPROVED', async () => {
    const fixtureAccounts = await fixture();
    await postDeposit(prisma, {
      externalRef: 'deposit:dispatch:throw',
      userId: fixtureAccounts.user.id,
      userCouponAccountId: fixtureAccounts.userAccount.id,
      externalOnchainAccountId: fixtureAccounts.external.id,
      vaultAccountId: fixtureAccounts.vault.id,
      issuanceAccountId: fixtureAccounts.issuance.id,
      amountMicroUsdt: 2_000_000_000n,
    });
    const withdrawal = await requestWithdrawal(prisma, {
      userId: fixtureAccounts.user.id,
      userAccountId: fixtureAccounts.userAccount.id,
      destinationAddress: getAddress(`0x${'cc'.repeat(20)}`),
      couponsGross: 50_000n,
      baseFeeBps: 100n,
      minimumFeeMicroUsdt: 0n,
      minimumWithdrawalMicroUsdt: 1n,
      autoApprovalLimitMicroUsdt: 1_000_000_000n,
      vaultAccountId: fixtureAccounts.vault.id,
      feeAccountId: fixtureAccounts.fees.id,
      pendingAccountId: fixtureAccounts.pending.id,
      issuanceAccountId: fixtureAccounts.issuance.id,
      cooldownHours: 0,
    });
    const signer = new FakeTransactionSigner(
      getAddress(`0x${'dd'.repeat(20)}`),
      '0x01',
      async () => {
        throw new Error('signing failed');
      },
    );
    await expect(dispatchWithdrawal(prisma, new FakeChainProvider(), signer, dispatchConfig, withdrawal.id)).rejects.toThrow('signing failed');
    expect(signer.signCount).toBe(1);
    expect(await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } })).toMatchObject({
      status: WithdrawalStatus.APPROVED,
      chainTxHash: null,
    });
  });

  it('checks USDT and native funding before signing', async () => {
    const fixtureAccounts = await fixture();
    await postDeposit(prisma, {
      externalRef: 'deposit:dispatch:funding',
      userId: fixtureAccounts.user.id,
      userCouponAccountId: fixtureAccounts.userAccount.id,
      externalOnchainAccountId: fixtureAccounts.external.id,
      vaultAccountId: fixtureAccounts.vault.id,
      issuanceAccountId: fixtureAccounts.issuance.id,
      amountMicroUsdt: 2_000_000_000n,
    });
    const makeWithdrawal = (id: string) => requestWithdrawal(prisma, {
      userId: fixtureAccounts.user.id,
      userAccountId: fixtureAccounts.userAccount.id,
      destinationAddress: getAddress(`0x${id.repeat(40 / id.length)}`),
      couponsGross: 50_000n,
      baseFeeBps: 100n,
      minimumFeeMicroUsdt: 0n,
      minimumWithdrawalMicroUsdt: 1n,
      autoApprovalLimitMicroUsdt: 1_000_000_000n,
      vaultAccountId: fixtureAccounts.vault.id,
      feeAccountId: fixtureAccounts.fees.id,
      pendingAccountId: fixtureAccounts.pending.id,
      issuanceAccountId: fixtureAccounts.issuance.id,
      cooldownHours: 0,
    });
    const first = await makeWithdrawal('e');
    const signer = new FakeTransactionSigner(getAddress(`0x${'dd'.repeat(20)}`), '0x01');
    const noUsdt = new FakeChainProvider({
      tokenBalances: new Map([[`${usdt.toLowerCase()}:${signer.address.toLowerCase()}`, 0n]]),
    });
    await expect(dispatchWithdrawal(prisma, noUsdt, signer, dispatchConfig, first.id)).rejects.toThrow('insufficient USDT');
    expect(signer.signCount).toBe(0);
    expect((await prisma.withdrawal.findUniqueOrThrow({ where: { id: first.id } })).status).toBe(WithdrawalStatus.APPROVED);

    const second = await makeWithdrawal('f');
    const noNative = new FakeChainProvider({
      nativeBalances: new Map([[signer.address.toLowerCase(), 0n]]),
    });
    await expect(dispatchWithdrawal(prisma, noNative, signer, dispatchConfig, second.id)).rejects.toThrow('insufficient native');
    expect(signer.signCount).toBe(0);
    expect((await prisma.withdrawal.findUniqueOrThrow({ where: { id: second.id } })).status).toBe(WithdrawalStatus.APPROVED);
  });

  it('does not sign when the latest node block is stale', async () => {
    const fixtureAccounts = await fixture();
    await postDeposit(prisma, {
      externalRef: 'deposit:dispatch:stale',
      userId: fixtureAccounts.user.id,
      userCouponAccountId: fixtureAccounts.userAccount.id,
      externalOnchainAccountId: fixtureAccounts.external.id,
      vaultAccountId: fixtureAccounts.vault.id,
      issuanceAccountId: fixtureAccounts.issuance.id,
      amountMicroUsdt: 2_000_000_000n,
    });
    const withdrawal = await requestWithdrawal(prisma, {
      userId: fixtureAccounts.user.id,
      userAccountId: fixtureAccounts.userAccount.id,
      destinationAddress: getAddress(`0x${'cc'.repeat(20)}`),
      couponsGross: 50_000n,
      baseFeeBps: 100n,
      minimumFeeMicroUsdt: 0n,
      minimumWithdrawalMicroUsdt: 1n,
      autoApprovalLimitMicroUsdt: 1_000_000_000n,
      vaultAccountId: fixtureAccounts.vault.id,
      feeAccountId: fixtureAccounts.fees.id,
      pendingAccountId: fixtureAccounts.pending.id,
      issuanceAccountId: fixtureAccounts.issuance.id,
      cooldownHours: 0,
    });
    const signer = new FakeTransactionSigner(getAddress(`0x${'dd'.repeat(20)}`), '0x01');
    const provider = new FakeChainProvider({ head: 5, blockTimestamps: new Map([[5, Math.floor(Date.now() / 1000) - 121]]) });
    await expect(dispatchWithdrawal(prisma, provider, signer, { ...dispatchConfig, chainMaxBlockAgeSeconds: 120 }, withdrawal.id)).rejects.toThrow('chain head is stale');
    expect(signer.signCount).toBe(0);
    expect(await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } })).toMatchObject({ status: WithdrawalStatus.APPROVED });
  });

  it('does not dispatch a withdrawal before its cooldown elapses', async () => {
    const fixtureAccounts = await fixture();
    await postDeposit(prisma, {
      externalRef: 'deposit:dispatch:cooldown',
      userId: fixtureAccounts.user.id,
      userCouponAccountId: fixtureAccounts.userAccount.id,
      externalOnchainAccountId: fixtureAccounts.external.id,
      vaultAccountId: fixtureAccounts.vault.id,
      issuanceAccountId: fixtureAccounts.issuance.id,
      amountMicroUsdt: 2_000_000_000n,
    });
    const withdrawal = await requestWithdrawal(prisma, {
      userId: fixtureAccounts.user.id,
      userAccountId: fixtureAccounts.userAccount.id,
      destinationAddress: getAddress(`0x${'cc'.repeat(20)}`),
      couponsGross: 50_000n,
      baseFeeBps: 100n,
      minimumFeeMicroUsdt: 0n,
      minimumWithdrawalMicroUsdt: 1n,
      autoApprovalLimitMicroUsdt: 1_000_000_000n,
      cooldownHours: 168,
      vaultAccountId: fixtureAccounts.vault.id,
      feeAccountId: fixtureAccounts.fees.id,
      pendingAccountId: fixtureAccounts.pending.id,
      issuanceAccountId: fixtureAccounts.issuance.id,
    });
    const signer = new FakeTransactionSigner(getAddress(`0x${'dd'.repeat(20)}`), '0x01');
    await expect(dispatchWithdrawal(prisma, new FakeChainProvider(), signer, dispatchConfig, withdrawal.id)).rejects.toThrow('cooldown has not elapsed');
    expect(signer.signCount).toBe(0);
    expect(await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } })).toMatchObject({ status: WithdrawalStatus.APPROVED });
  });
});

describe('demo churn', () => {
  async function demoAccount(barcodeId: string, balance: bigint) {
    const user = await prisma.user.create({ data: { phoneNumber: `+1555${barcodeId}`, barcodeId, isDemo: true } });
    const userAccount = await account(AccountType.USER_COUPON, Asset.COUPON, user.id);
    await prisma.ledgerAccount.update({ where: { id: userAccount.id }, data: { balance } });
    return { user, account: userAccount };
  }

  it('does not access the database when disabled', async () => {
    const queryRaw = vi.fn();
    const config = loadWorkerConfig({
      DATABASE_URL: 'postgresql://localhost/trustme',
      REDIS_URL: 'redis://localhost:6379',
      POLYGON_RPC_URL: 'https://polygon.example',
      USDT_CONTRACT_ADDRESS: `0x${'aa'.repeat(20)}`,
      HOT_WALLET_PRIVATE_KEY: 'test-key',
    });
    const result = await churnDemoCoupons({ $queryRaw: queryRaw } as unknown as PrismaClient, {
      enabled: config.allowDemoData,
      transfersPerTick: 3,
      maxCouponsPerTransfer: config.demoChurnMaxCoupons,
    }, { warn: vi.fn() });
    expect(result).toEqual({ status: 'disabled' });
    expect(queryRaw).not.toHaveBeenCalled();
    expect(config.demoChurnIntervalMs).toBe(30_000);
    expect(config.demoChurnTransfersPerTick).toBe(3);
  });

  it('only transfers between demo users and preserves demo circulation', async () => {
    const issuance = await account(AccountType.SYSTEM_DEMO_ISSUANCE, Asset.COUPON);
    await prisma.ledgerAccount.update({ where: { id: issuance.id }, data: { balance: -100n } });
    const sender = await demoAccount('demo-churn-sender', 40n);
    const recipient = await demoAccount('demo-churn-recipient', 60n);
    const realUser = await prisma.user.create({ data: { phoneNumber: '+15550009998', barcodeId: 'demo-churn-real' } });
    const realAccount = await account(AccountType.USER_COUPON, Asset.COUPON, realUser.id);
    await prisma.ledgerAccount.update({ where: { id: realAccount.id }, data: { balance: 100n } });
    const before = await readDemoCirculation(prisma);

    const result = await churnDemoCoupons(prisma, {
      enabled: true,
      transfersPerTick: 5,
      maxCouponsPerTransfer: 10,
    }, { warn: vi.fn() });

    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.transfers).toBeGreaterThan(0);
    expect(await readDemoCirculation(prisma)).toBe(before);
    const transactions = await prisma.transaction.findMany({
      where: { type: 'TRANSFER' },
      include: { entries: true },
    });
    expect(transactions.length).toBeGreaterThan(0);
    for (const transaction of transactions) {
      expect([sender.user.id, recipient.user.id]).toContain(transaction.userId);
      for (const entry of transaction.entries) {
        expect([sender.account.id, recipient.account.id]).toContain(entry.fromAccountId);
        expect([sender.account.id, recipient.account.id]).toContain(entry.toAccountId);
        expect(entry.fromAccountId).not.toBe(realAccount.id);
        expect(entry.toAccountId).not.toBe(realAccount.id);
      }
    }
  });

  it('is a no-op when there is no funded demo account', async () => {
    const issuance = await account(AccountType.SYSTEM_DEMO_ISSUANCE, Asset.COUPON);
    const demo = await demoAccount('demo-churn-empty', 0n);
    const before = await readDemoCirculation(prisma);
    const result = await churnDemoCoupons(prisma, {
      enabled: true,
      transfersPerTick: 3,
      maxCouponsPerTransfer: 50,
    }, { warn: vi.fn() });

    expect(result).toEqual({ status: 'ok', transfers: 0, skipped: 3 });
    expect(await readDemoCirculation(prisma)).toBe(before);
    expect(await prisma.transaction.count()).toBe(0);
    expect((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: demo.account.id } })).balance).toBe(0n);
    expect((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: issuance.id } })).balance).toBe(0n);
  });
});
