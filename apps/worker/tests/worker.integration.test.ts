import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { id, zeroPadValue, getAddress } from 'ethers';
import { AccountType, Asset, PrismaClient, WithdrawalStatus } from '@trustme/db';
import { postDeposit, requestWithdrawal } from '@trustme/core';
import { confirmWithdrawal, dispatchWithdrawal } from '../src/dispatch.js';
import { ingestOnce } from '../src/ingest.js';
import { FakeChainProvider, FakeTransactionSigner } from '../src/provider.js';

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

async function account(type: AccountType, asset: Asset, userId?: string) {
  return prisma.ledgerAccount.create({ data: { type, asset, ...(userId === undefined ? {} : { userId }) } });
}

async function fixture() {
  const user = await prisma.user.create({ data: { phoneNumber: '+1555000999', barcodeId: 'worker-user' } });
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

beforeAll(async () => {
  await prisma.$connect();
});
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "AdminAuditLog", "AdminUser", "Withdrawal", "EscrowHold", "LoanInstallment", "Guarantee", "Loan", "LedgerEntry", "Transaction", "LedgerAccount", "DepositAddress", "User", "ChainCursor" CASCADE');
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('chain ingest', () => {
  it('processes confirmed deposits and replays idempotently', async () => {
    const fixtureAccounts = await fixture();
    const provider = new FakeChainProvider({
      head: 112,
      blockHashes: new Map([[100, '0x100'], [101, '0x101'], [102, '0x102'], [103, '0x103']]),
      logs: [fixtureAccounts.onchainLog],
    });
    const config = { usdtContractAddress: usdt, chainStartBlock: 100, confirmations: 12, maxBlockRange: 2_000, reorgRewindBlocks: 64 };
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
    const config = { usdtContractAddress: usdt, chainStartBlock: 100, confirmations: 12, maxBlockRange: 2_000, reorgRewindBlocks: 64 };
    await expect(ingestOnce(prisma, provider, config)).resolves.toMatchObject({ scannedThrough: null, processed: 0 });
    expect(await prisma.transaction.count()).toBe(0);
  });

  it('rewinds on a previous-block hash mismatch', async () => {
    const fixtureAccounts = await fixture();
    const config = { usdtContractAddress: usdt, chainStartBlock: 100, confirmations: 1, maxBlockRange: 10, reorgRewindBlocks: 64 };
    await prisma.chainCursor.create({ data: { id: 1, nextBlock: 150n, lastBlockHash: '0xold' } });
    const provider = new FakeChainProvider({ head: 200, blockHashes: new Map([[149, '0xnew']]), logs: [fixtureAccounts.onchainLog] });
    await expect(ingestOnce(prisma, provider, config)).resolves.toMatchObject({ rewound: true });
    expect(await prisma.chainCursor.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ nextBlock: 100n, lastBlockHash: null });
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
