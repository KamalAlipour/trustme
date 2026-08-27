import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient, AccountType, Asset, EscrowStatus, WithdrawalStatus } from '@trustme/db';
import {
  createEscrowHold,
  postDeposit,
  quoteWithdrawalForUsdt,
  refundWithdrawal,
  releaseEscrow,
  requestWithdrawal,
  transferCoupons,
} from '../src/index.js';

const prisma = new PrismaClient();
type Accounts = { issuance: string; external: string; vault: string; pending: string; fees: string; users: string[]; escrows: string[] };

async function account(type: AccountType, asset: Asset, userId?: string) {
  return prisma.ledgerAccount.create({ data: { type, asset, ...(userId === undefined ? {} : { userId }) } });
}

async function fixture(userCount = 2): Promise<Accounts & { users: string[] }> {
  const users: string[] = [];
  const userAccounts: string[] = [];
  const escrowAccounts: string[] = [];
  for (let index = 0; index < userCount; index += 1) {
    const user = await prisma.user.create({ data: { phoneNumber: `+1555000${index}`, barcodeId: `bc-${index}` } });
    users.push(user.id);
    userAccounts.push((await account(AccountType.USER_COUPON, Asset.COUPON, user.id)).id);
    escrowAccounts.push((await account(AccountType.ESCROW, Asset.COUPON, user.id)).id);
  }
  return {
    issuance: (await account(AccountType.SYSTEM_COUPON_ISSUANCE, Asset.COUPON)).id,
    external: (await account(AccountType.EXTERNAL_ONCHAIN, Asset.USDT)).id,
    vault: (await account(AccountType.SYSTEM_VAULT_USDT, Asset.USDT)).id,
    pending: (await account(AccountType.SYSTEM_WITHDRAWAL_PENDING, Asset.USDT)).id,
    fees: (await account(AccountType.SYSTEM_FEE_COLLECTION, Asset.USDT)).id,
    users: userAccounts,
    escrows: escrowAccounts,
  };
}

beforeAll(async () => {
  await prisma.$connect();
});
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "AdminAuditLog", "AdminUser", "Withdrawal", "EscrowHold", "LedgerEntry", "Transaction", "LedgerAccount", "DepositAddress", "User" CASCADE');
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('money and ledger domain', () => {
  it('posts a deposit and records exact dust', async () => {
    const fixtureAccounts = await fixture(1);
    const transaction = await postDeposit(prisma, {
      externalRef: 'deposit:0xabc:0',
      userId: (await prisma.user.findFirstOrThrow()).id,
      userCouponAccountId: fixtureAccounts.users[0]!,
      externalOnchainAccountId: fixtureAccounts.external,
      vaultAccountId: fixtureAccounts.vault,
      issuanceAccountId: fixtureAccounts.issuance,
      amountMicroUsdt: 12_345_678n,
    });
    expect(transaction.amountCoupons).toBe(1_234n);
    expect(transaction.roundingDustMicroUsdt).toBe(5_678n);
    expect(await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: fixtureAccounts.users[0]! } })).toMatchObject({ balance: 1_234n });
    expect(await prisma.ledgerEntry.count({ where: { transactionId: transaction.id } })).toBe(2);
    const dustOnly = await postDeposit(prisma, {
      externalRef: 'deposit:0xabc:1',
      userId: (await prisma.user.findFirstOrThrow()).id,
      userCouponAccountId: fixtureAccounts.users[0]!,
      externalOnchainAccountId: fixtureAccounts.external,
      vaultAccountId: fixtureAccounts.vault,
      issuanceAccountId: fixtureAccounts.issuance,
      amountMicroUsdt: 1n,
    });
    expect(dustOnly.amountCoupons).toBe(0n);
    expect(dustOnly.roundingDustMicroUsdt).toBe(1n);
    expect(await prisma.ledgerEntry.count({ where: { transactionId: dustOnly.id } })).toBe(1);
  });

  it('preserves per-asset zero sums through randomized transfers', async () => {
    const fixtureAccounts = await fixture(3);
    await postDeposit(prisma, {
      externalRef: 'deposit:seed:0',
      userId: (await prisma.user.findFirstOrThrow()).id,
      userCouponAccountId: fixtureAccounts.users[0]!,
      externalOnchainAccountId: fixtureAccounts.external,
      vaultAccountId: fixtureAccounts.vault,
      issuanceAccountId: fixtureAccounts.issuance,
      amountMicroUsdt: 1_000_000_000n,
    });
    await transferCoupons(prisma, { externalRef: 'seed-transfer', fromAccountId: fixtureAccounts.users[0]!, toAccountId: fixtureAccounts.users[1]!, amountCoupons: 10_000n });
    await transferCoupons(prisma, { externalRef: 'seed-transfer-2', fromAccountId: fixtureAccounts.users[0]!, toAccountId: fixtureAccounts.users[2]!, amountCoupons: 20_000n });
    for (let index = 0; index < 50; index += 1) {
      const from = fixtureAccounts.users[index % 3]!;
      const to = fixtureAccounts.users[(index + 1) % 3]!;
      const balances = await prisma.ledgerAccount.findMany({ where: { id: { in: fixtureAccounts.users } } });
      const available = balances.find((item) => item.id === from)?.balance ?? 0n;
      const amount = available > 3n ? 3n : available;
      if (amount > 0n) await transferCoupons(prisma, { externalRef: `random:${index}`, fromAccountId: from, toAccountId: to, amountCoupons: amount });
    }
    const sums = await prisma.ledgerAccount.groupBy({ by: ['asset'], _sum: { balance: true } });
    expect(sums.every((sum) => sum._sum.balance === 0n)).toBe(true);
    expect((await prisma.ledgerAccount.findMany({ where: { type: AccountType.USER_COUPON } })).every((item) => item.balance >= 0n)).toBe(true);
  });

  it('runs opposite concurrent transfers without lost updates', async () => {
    const fixtureAccounts = await fixture(2);
    await postDeposit(prisma, {
      externalRef: 'deposit:concurrent:0',
      userId: (await prisma.user.findFirstOrThrow()).id,
      userCouponAccountId: fixtureAccounts.users[0]!,
      externalOnchainAccountId: fixtureAccounts.external,
      vaultAccountId: fixtureAccounts.vault,
      issuanceAccountId: fixtureAccounts.issuance,
      amountMicroUsdt: 1_000_000_000n,
    });
    await transferCoupons(prisma, { externalRef: 'initial', fromAccountId: fixtureAccounts.users[0]!, toAccountId: fixtureAccounts.users[1]!, amountCoupons: 50_000n });
    const clients = await Promise.all(Array.from({ length: 20 }, () => Promise.resolve(new PrismaClient())));
    try {
      await Promise.all(clients.map((client, index) => transferCoupons(client, {
        externalRef: `parallel:${index}`,
        fromAccountId: index % 2 === 0 ? fixtureAccounts.users[0]! : fixtureAccounts.users[1]!,
        toAccountId: index % 2 === 0 ? fixtureAccounts.users[1]! : fixtureAccounts.users[0]!,
        amountCoupons: 100n,
      })));
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
    const balances = await prisma.ledgerAccount.findMany({ where: { id: { in: fixtureAccounts.users } }, orderBy: { id: 'asc' } });
    expect(balances.reduce((sum, item) => sum + item.balance, 0n)).toBe(100_000n);
    expect(balances.map((item) => item.balance)).toEqual([50_000n, 50_000n]);
  });

  it('is idempotent on external reference', async () => {
    const fixtureAccounts = await fixture(2);
    const input = { externalRef: 'transfer:replay', fromAccountId: fixtureAccounts.users[0]!, toAccountId: fixtureAccounts.users[1]!, amountCoupons: 1n };
    await postDeposit(prisma, { externalRef: 'deposit:replay:0', userId: (await prisma.user.findFirstOrThrow()).id, userCouponAccountId: fixtureAccounts.users[0]!, externalOnchainAccountId: fixtureAccounts.external, vaultAccountId: fixtureAccounts.vault, issuanceAccountId: fixtureAccounts.issuance, amountMicroUsdt: 10_000n });
    const first = await transferCoupons(prisma, input);
    const second = await transferCoupons(prisma, input);
    expect(second.id).toBe(first.id);
    expect(await prisma.ledgerEntry.count({ where: { transactionId: first.id } })).toBe(1);
  });

  it('rejects a coupon transfer that would make the user negative', async () => {
    const fixtureAccounts = await fixture(2);
    await expect(transferCoupons(prisma, {
      externalRef: 'transfer:overspend',
      fromAccountId: fixtureAccounts.users[0]!,
      toAccountId: fixtureAccounts.users[1]!,
      amountCoupons: 1n,
    })).rejects.toThrow('cannot be negative');
  });

  it('calculates fee, net, and approval boundaries with integer arithmetic', () => {
    expect(quoteWithdrawalForUsdt(10_000n, 125n, 1_000_000n)).toEqual({ grossMicroUsdt: 100_000_000n, feeMicroUsdt: 1_250_000n, netMicroUsdt: 98_750_000n });
    expect(quoteWithdrawalForUsdt(100n, 100n, 990_000n).netMicroUsdt).toBe(990_000n);
    expect(() => quoteWithdrawalForUsdt(100n, 100n, 990_001n)).toThrow();
  });

  it('restores exact balances on withdrawal refund', async () => {
    const fixtureAccounts = await fixture(1);
    const userId = (await prisma.user.findFirstOrThrow()).id;
    await postDeposit(prisma, { externalRef: 'deposit:withdrawal:0', userId, userCouponAccountId: fixtureAccounts.users[0]!, externalOnchainAccountId: fixtureAccounts.external, vaultAccountId: fixtureAccounts.vault, issuanceAccountId: fixtureAccounts.issuance, amountMicroUsdt: 100_000_000n });
    const before = await prisma.ledgerAccount.findMany({ where: { id: { in: [fixtureAccounts.users[0]!, fixtureAccounts.vault, fixtureAccounts.pending, fixtureAccounts.fees, fixtureAccounts.issuance] } }, orderBy: { id: 'asc' } });
    const withdrawal = await requestWithdrawal(prisma, { userId, userAccountId: fixtureAccounts.users[0]!, destinationAddress: '0x52908400098527886E0F7030069857D2E4169EE7', couponsGross: 1_000n, baseFeeBps: 100n, minimumWithdrawalMicroUsdt: 1n, autoApprovalLimitMicroUsdt: 1_000_000_000n, vaultAccountId: fixtureAccounts.vault, feeAccountId: fixtureAccounts.fees, pendingAccountId: fixtureAccounts.pending, issuanceAccountId: fixtureAccounts.issuance });
    await refundWithdrawal(prisma, { withdrawalId: withdrawal.id, userAccountId: fixtureAccounts.users[0]!, vaultAccountId: fixtureAccounts.vault, feeAccountId: fixtureAccounts.fees, pendingAccountId: fixtureAccounts.pending, issuanceAccountId: fixtureAccounts.issuance });
    const after = await prisma.ledgerAccount.findMany({ where: { id: { in: [fixtureAccounts.users[0]!, fixtureAccounts.vault, fixtureAccounts.pending, fixtureAccounts.fees, fixtureAccounts.issuance] } }, orderBy: { id: 'asc' } });
    expect(after.map((item) => item.balance)).toEqual(before.map((item) => item.balance));
    expect((await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } })).status).toBe(WithdrawalStatus.REFUNDED);
  });

  it('locks escrow after five wrong codes and never stores plaintext code', async () => {
    const fixtureAccounts = await fixture(2);
    const users = await prisma.user.findMany({ orderBy: { barcodeId: 'asc' } });
    await postDeposit(prisma, { externalRef: 'deposit:escrow:0', userId: users[0]!.id, userCouponAccountId: fixtureAccounts.users[0]!, externalOnchainAccountId: fixtureAccounts.external, vaultAccountId: fixtureAccounts.vault, issuanceAccountId: fixtureAccounts.issuance, amountMicroUsdt: 1_000_000n });
    const hold = await createEscrowHold(prisma, { senderId: users[0]!.id, recipientId: users[1]!.id, senderAccountId: fixtureAccounts.users[0]!, escrowAccountId: fixtureAccounts.escrows[0]!, amountCoupons: 10n, code: '1234', expiresAt: new Date(Date.now() + 60_000) });
    expect(hold.codeHash).not.toContain('1234');
    for (let attempt = 0; attempt < 5; attempt += 1) await expect(releaseEscrow(prisma, { holdId: hold.id, recipientAccountId: fixtureAccounts.users[1]!, code: '0000' })).rejects.toThrow();
    expect((await prisma.escrowHold.findUniqueOrThrow({ where: { id: hold.id } })).status).toBe(EscrowStatus.LOCKED);
  });
});
