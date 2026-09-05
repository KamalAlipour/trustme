import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient, AccountType, Asset, CharityAgentRole, CommissionPayoutRole, EscrowEventKind, EscrowStatus, TransactionStatus, WithdrawalStatus } from '@trustme/db';
import {
  calculateSolvency,
  issueDemoCoupons,
  readDemoCirculation,
  readSolvency,
  reconcileDemoIssuance,
  cancelEscrow,
  createEscrowHold,
  postDeposit,
  quoteWithdrawalForUsdt,
  readWithdrawalAvailability,
  rejectWithdrawal,
  refundWithdrawal,
  releaseEscrow,
  requestWithdrawal,
  transferCoupons,
  applyEscrowChainEvent,
  confirmSettlement,
  createPayCode,
  failSettlement,
  requestUnload,
  confirmUnload,
  failUnload,
  settleWithPayCode,
  settleDirectedPayCode,
  approveAidRequest,
  createAidRequest,
  revokePurchaseGuarantee,
  forceAutoResolve,
  grantRateDiscount,
  logCommissionStrike,
  setCommissionRate,
  setTrainer,
  referralSummary,
  splitCommission,
  readSolvency,
} from '../src/index.js';

const prisma = new PrismaClient();
type Accounts = { issuance: string; external: string; vault: string; pending: string; fees: string; couponFees: string; users: string[]; escrows: string[] };

async function account(type: AccountType, asset: Asset, userId?: string) {
  return prisma.ledgerAccount.create({ data: { type, asset, ...(userId === undefined ? {} : { userId }) } });
}

async function fixture(userCount = 2): Promise<Accounts & { users: string[] }> {
  const users: string[] = [];
  const userAccounts: string[] = [];
  const escrowAccounts: string[] = [];
  for (let index = 0; index < userCount; index += 1) {
    const user = await prisma.user.create({ data: { phoneNumber: `+1555000${index}`, barcodeId: `bc-${index}`, identityVerificationStatus: 'VERIFIED', identityVerifiedAt: new Date() } });
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
    couponFees: (await account(AccountType.SYSTEM_FEE_COLLECTION, Asset.COUPON)).id,
    users: userAccounts,
    escrows: escrowAccounts,
  };
}

beforeAll(async () => {
  await prisma.$connect();
});
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "ApiKey", "CommissionPayout", "EscrowChainEvent", "EscrowUnload", "EscrowSettlement", "PayCode", "EscrowBalance", "MemberWallet", "MediaAsset", "RefundRequest", "AidRequest", "CharityAgent", "Charity", "AdminAuditLog", "AdminUser", "Withdrawal", "EscrowHold", "EmailVerification", "MemberDevice", "Contact", "LoanInstallment", "Guarantee", "Loan", "LedgerEntry", "Transaction", "LedgerAccount", "DepositAddress", "User" CASCADE');
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('money and ledger domain', () => {
  it('releases escrow with buyer-marketer commission and keeps zero-rate sellers unchanged', async () => {
    const fixtureAccounts = await fixture(3);
    const users = await prisma.user.findMany({ orderBy: { phoneNumber: 'asc' }, take: 3 });
    const [buyer, seller, partner] = users;
    await prisma.user.update({ where: { id: buyer!.id }, data: { marketerId: partner!.id } });
    await prisma.user.update({ where: { id: seller!.id }, data: { commissionRateBps: 300 } });
    await postDeposit(prisma, {
      externalRef: 'deposit:escrow-commission:0',
      userId: buyer!.id,
      userCouponAccountId: fixtureAccounts.users[0]!,
      externalOnchainAccountId: fixtureAccounts.external,
      vaultAccountId: fixtureAccounts.vault,
      issuanceAccountId: fixtureAccounts.issuance,
      amountMicroUsdt: 20_000n * 10_000n,
    });
    const hold = await createEscrowHold(prisma, {
      senderId: buyer!.id,
      recipientId: seller!.id,
      senderAccountId: fixtureAccounts.users[0]!,
      escrowAccountId: fixtureAccounts.escrows[0]!,
      amountCoupons: 1_000n,
      code: '1234',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const beforeRelease = await prisma.ledgerAccount.findMany({ where: { asset: Asset.COUPON }, select: { id: true, balance: true } });
    const released = await releaseEscrow(prisma, {
      holdId: hold.id,
      recipientAccountId: fixtureAccounts.users[1]!,
      code: '1234',
    });
    expect(released.status).toBe('RELEASED');
    expect(await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: fixtureAccounts.users[1]! } })).toMatchObject({ balance: 970n });
    expect(await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: fixtureAccounts.users[2]! } })).toMatchObject({ balance: 10n });
    expect(await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: fixtureAccounts.couponFees } })).toMatchObject({ balance: 20n });
    const payouts = await prisma.commissionPayout.findMany({ where: { transactionId: released.releaseTransactionId! } });
    expect(payouts).toEqual([expect.objectContaining({ recipientId: partner!.id, role: 'BUYER_MARKETER', amount: 10n })]);
    const afterRelease = await prisma.ledgerAccount.findMany({ where: { asset: Asset.COUPON }, select: { id: true, balance: true } });
    const beforeBalances = new Map(beforeRelease.map((account) => [account.id, account.balance]));
    expect(afterRelease.reduce((sum, account) => sum + account.balance - (beforeBalances.get(account.id) ?? 0n), 0n)).toBe(0n);

    const zeroRate = await prisma.user.create({ data: { barcodeId: 'zero-rate-seller' } });
    const zeroAccount = await account(AccountType.USER_COUPON, Asset.COUPON, zeroRate.id);
    await prisma.user.update({ where: { id: zeroRate.id }, data: { commissionRateBps: 0 } });
    const secondHold = await createEscrowHold(prisma, {
      senderId: buyer!.id,
      recipientId: zeroRate.id,
      senderAccountId: fixtureAccounts.users[0]!,
      escrowAccountId: fixtureAccounts.escrows[0]!,
      amountCoupons: 100n,
      code: '2345',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const secondRelease = await releaseEscrow(prisma, { holdId: secondHold.id, recipientAccountId: zeroAccount.id, code: '2345' });
    expect(await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: zeroAccount.id } })).toMatchObject({ balance: 100n });
    expect(await prisma.ledgerEntry.count({ where: { transactionId: secondRelease.releaseTransactionId! } })).toBe(1);
  });

  it('posts seller commission legs atomically with a coupon transfer', async () => {
    const fixtureAccounts = await fixture(4);
    const users = await prisma.user.findMany({ orderBy: { phoneNumber: 'asc' }, take: 4 });
    const [buyer, seller, buyerMarketer, sellerMarketer] = users;
    await prisma.user.update({ where: { id: buyer!.id }, data: { marketerId: buyerMarketer!.id } });
    await prisma.user.update({ where: { id: seller!.id }, data: { marketerId: sellerMarketer!.id, commissionRateBps: 300 } });
    await postDeposit(prisma, {
      externalRef: 'deposit:commission:0',
      userId: buyer!.id,
      userCouponAccountId: fixtureAccounts.users[0]!,
      externalOnchainAccountId: fixtureAccounts.external,
      vaultAccountId: fixtureAccounts.vault,
      issuanceAccountId: fixtureAccounts.issuance,
      amountMicroUsdt: 10_000n * 10_000n,
    });
    await transferCoupons(prisma, { externalRef: 'transfer:commission:0', userId: buyer!.id, fromAccountId: fixtureAccounts.users[0]!, toAccountId: fixtureAccounts.users[1]!, amountCoupons: 1_000n });
    const balances = await prisma.ledgerAccount.findMany({ where: { id: { in: [fixtureAccounts.users[0]!, fixtureAccounts.users[1]!, fixtureAccounts.users[2]!, fixtureAccounts.users[3]!, fixtureAccounts.couponFees] } } });
    expect(Object.fromEntries(balances.map((account) => [account.id, account.balance]))).toMatchObject({
      [fixtureAccounts.users[0]!]: 9_000n,
      [fixtureAccounts.users[1]!]: 970n,
      [fixtureAccounts.users[2]!]: 10n,
      [fixtureAccounts.users[3]!]: 10n,
      [fixtureAccounts.couponFees]: 10n,
    });
    expect(splitCommission(1_000n, 300)).toMatchObject({ fee: 30n });
  });

  it('reverses pay-code commission legs together with merchant credit', async () => {
    const fixtureAccounts = await fixture(4);
    const users = await prisma.user.findMany({ orderBy: { phoneNumber: 'asc' }, take: 4 });
    const [buyer, merchant, buyerMarketer, sellerMarketer] = users;
    await prisma.user.update({ where: { id: buyer!.id }, data: { marketerId: buyerMarketer!.id } });
    await prisma.user.update({ where: { id: merchant!.id }, data: { marketerId: sellerMarketer!.id, commissionRateBps: 300 } });
    await prisma.escrowBalance.create({ data: { userId: buyer!.id, lockedMicroUsdt: 1_000_000n } });
    await createPayCode(prisma, {
      buyerId: buyer!.id,
      merchantId: merchant!.id,
      amountMicroUsdt: 1_000_000n,
      maxAmountMicroUsdt: 1_000_000n,
      code: '1234',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const settled = await settleWithPayCode(prisma, {
      merchantId: merchant!.id,
      buyerBarcodeId: buyer!.barcodeId,
      code: '1234',
      amountMicroUsdt: 1_000_000n,
    });
    expect(settled.settlement.payerId).toBe(buyer!.id);
    const afterSettlement = await prisma.ledgerAccount.findMany({
      where: { id: { in: [fixtureAccounts.users[1]!, fixtureAccounts.users[2]!, fixtureAccounts.users[3]!, fixtureAccounts.couponFees] } },
    });
    expect(Object.fromEntries(afterSettlement.map((account) => [account.id, account.balance]))).toMatchObject({
      [fixtureAccounts.users[1]!]: 97n,
      [fixtureAccounts.users[2]!]: 1n,
      [fixtureAccounts.users[3]!]: 1n,
      [fixtureAccounts.couponFees]: 1n,
    });
    await failSettlement(prisma, { settlementId: settled.settlement.id, error: 'provider failure' });
    const afterFailure = await prisma.ledgerAccount.findMany({
      where: { id: { in: [fixtureAccounts.users[1]!, fixtureAccounts.users[2]!, fixtureAccounts.users[3]!, fixtureAccounts.couponFees] } },
    });
    expect(afterFailure.every((account) => account.balance === 0n)).toBe(true);
  });

  it('splits marketer shares to a trainer and records payout attribution', async () => {
    const fixtureAccounts = await fixture(4);
    const users = await prisma.user.findMany({ orderBy: { phoneNumber: 'asc' }, take: 4 });
    const [buyer, merchant, marketer, trainer] = users;
    await prisma.user.update({ where: { id: marketer!.id }, data: { trainerId: trainer!.id } });
    await prisma.user.update({ where: { id: merchant!.id }, data: { marketerId: marketer!.id, commissionRateBps: 300 } });
    await postDeposit(prisma, {
      externalRef: 'deposit:trainer:0',
      userId: buyer!.id,
      userCouponAccountId: fixtureAccounts.users[0]!,
      externalOnchainAccountId: fixtureAccounts.external,
      vaultAccountId: fixtureAccounts.vault,
      issuanceAccountId: fixtureAccounts.issuance,
      amountMicroUsdt: 10_000n * 10_000n,
    });
    const transaction = await transferCoupons(prisma, {
      externalRef: 'transfer:trainer:0',
      userId: buyer!.id,
      fromAccountId: fixtureAccounts.users[0]!,
      toAccountId: fixtureAccounts.users[1]!,
      amountCoupons: 1_000n,
    });
    expect(await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: fixtureAccounts.users[1]! } })).toMatchObject({ balance: 970n });
    expect(await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: fixtureAccounts.users[2]! } })).toMatchObject({ balance: 8n });
    expect(await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: fixtureAccounts.users[3]! } })).toMatchObject({ balance: 2n });
    const payouts = await prisma.commissionPayout.findMany({ where: { transactionId: transaction.id }, orderBy: { role: 'asc' } });
    expect(payouts).toEqual(expect.arrayContaining([
      expect.objectContaining({ recipientId: marketer!.id, sourceUserId: merchant!.id, role: CommissionPayoutRole.SELLER_MARKETER, amount: 8n }),
      expect.objectContaining({ recipientId: trainer!.id, sourceUserId: marketer!.id, role: CommissionPayoutRole.TRAINER, amount: 2n }),
    ]));
    expect(payouts.reduce((sum, payout) => sum + payout.amount, 0n)).toBe(10n);
  });

  it('keeps the full marketer share when the trainer is missing and summarizes referrals', async () => {
    const fixtureAccounts = await fixture(3);
    const users = await prisma.user.findMany({ orderBy: { phoneNumber: 'asc' }, take: 3 });
    const [buyer, seller, marketer] = users;
    await prisma.user.update({ where: { id: seller!.id }, data: { marketerId: marketer!.id, commissionRateBps: 300 } });
    await prisma.user.update({ where: { id: buyer!.id }, data: { marketerId: marketer!.id } });
    await postDeposit(prisma, {
      externalRef: 'deposit:referral:0',
      userId: buyer!.id,
      userCouponAccountId: fixtureAccounts.users[0]!,
      externalOnchainAccountId: fixtureAccounts.external,
      vaultAccountId: fixtureAccounts.vault,
      issuanceAccountId: fixtureAccounts.issuance,
      amountMicroUsdt: 10_000n * 10_000n,
    });
    await transferCoupons(prisma, { externalRef: 'transfer:referral:0', userId: buyer!.id, fromAccountId: fixtureAccounts.users[0]!, toAccountId: fixtureAccounts.users[1]!, amountCoupons: 1_000n });
    expect(await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: fixtureAccounts.users[2]! } })).toMatchObject({ balance: 20n });
    await expect(referralSummary(prisma, marketer!.id)).resolves.toEqual({
      marketers: { count: 0, earnedCoupons: '0' },
      sellers: { count: 1, earnedCoupons: '10' },
      customers: { count: 1, earnedCoupons: '10' },
    });
  });

  it('sets trainers once and rejects self and direct cycles', async () => {
    await fixture(3);
    const users = await prisma.user.findMany({ orderBy: { phoneNumber: 'asc' }, take: 3 });
    const [member, trainer, cycle] = users;
    await expect(setTrainer(prisma, { userId: member!.id, trainerBarcodeId: trainer!.barcodeId })).resolves.toMatchObject({ trainerId: trainer!.id });
    await expect(setTrainer(prisma, { userId: member!.id, trainerBarcodeId: cycle!.barcodeId })).rejects.toThrow('already set');
    await expect(setTrainer(prisma, { userId: cycle!.id, trainerBarcodeId: cycle!.barcodeId })).rejects.toThrow('self-referral');
    await prisma.user.update({ where: { id: cycle!.id }, data: { trainerId: trainer!.id } });
    await expect(setTrainer(prisma, { userId: trainer!.id, trainerBarcodeId: cycle!.barcodeId })).rejects.toThrow('cycle');
  });

  it('enforces commission floors and marketer discount authorization', async () => {
    await fixture(3);
    const users = await prisma.user.findMany({ orderBy: { phoneNumber: 'asc' }, take: 3 });
    const [seller, marketer, stranger] = users;
    await expect(setCommissionRate(prisma, { userId: seller!.id, rateBps: 200, floorBps: 300 })).rejects.toThrow('commission rate is below the floor');
    await expect(setCommissionRate(prisma, { userId: seller!.id, rateBps: 0, floorBps: 300 })).resolves.toMatchObject({ commissionRateBps: 0 });
    await expect(setCommissionRate(prisma, { userId: seller!.id, rateBps: 500, floorBps: 300 })).resolves.toMatchObject({ commissionRateBps: 500 });
    await prisma.user.update({ where: { id: seller!.id }, data: { marketerId: marketer!.id } });
    await expect(grantRateDiscount(prisma, { marketerId: stranger!.id, sellerId: seller!.id, newRateBps: 400, floorBps: 300 })).rejects.toThrow('marketer is not assigned');
    await expect(grantRateDiscount(prisma, { marketerId: marketer!.id, sellerId: seller!.id, newRateBps: 500, floorBps: 300 })).rejects.toThrow('lower than the current rate');
    await expect(grantRateDiscount(prisma, { marketerId: marketer!.id, sellerId: seller!.id, newRateBps: 200, floorBps: 300 })).rejects.toThrow('commission rate is below the floor');
    await expect(grantRateDiscount(prisma, { marketerId: marketer!.id, sellerId: seller!.id, newRateBps: 400, floorBps: 300 })).resolves.toMatchObject({ commissionRateBps: 400 });
  });

  it('enforces strike timing and auto-resolves commission disputes at market average', async () => {
    await fixture(3);
    const users = await prisma.user.findMany({ orderBy: { phoneNumber: 'asc' }, take: 3 });
    const [seller, marketer, averageUser] = users;
    await prisma.user.updateMany({ where: { id: { in: [seller!.id, averageUser!.id] } }, data: { commissionRateBps: 500 } });
    await prisma.user.update({ where: { id: seller!.id }, data: { commissionRateBps: 1_000, marketerId: marketer!.id } });
    const first = new Date('2026-01-01T00:00:00.000Z');
    await expect(logCommissionStrike(prisma, { sellerId: seller!.id, now: first })).resolves.toMatchObject({ strikes: 1 });
    await expect(logCommissionStrike(prisma, { sellerId: seller!.id, now: new Date(first.getTime() + 9 * 24 * 60 * 60 * 1000) })).rejects.toThrow('not yet allowed');
    const secondAt = new Date(first.getTime() + 10 * 24 * 60 * 60 * 1000);
    await expect(logCommissionStrike(prisma, { sellerId: seller!.id, now: secondAt })).resolves.toMatchObject({ strikes: 2 });
    const thirdAt = new Date(secondAt.getTime() + 10 * 24 * 60 * 60 * 1000);
    await expect(logCommissionStrike(prisma, { sellerId: seller!.id, now: thirdAt })).resolves.toMatchObject({ strikes: 3 });
    await expect(forceAutoResolve(prisma, { sellerId: seller!.id, floorBps: 300, now: new Date(thirdAt.getTime() + 9 * 24 * 60 * 60 * 1000) })).rejects.toThrow('not yet eligible');
    await expect(forceAutoResolve(prisma, { sellerId: seller!.id, floorBps: 300, now: new Date(thirdAt.getTime() + 10 * 24 * 60 * 60 * 1000) })).resolves.toMatchObject({ status: 'AUTO_RESOLVED', resolvedRateBps: 750 });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: seller!.id } })).commissionRateBps).toBe(750);
    const lowSeller = await prisma.user.create({ data: { phoneNumber: '+1555000009', barcodeId: 'low-seller', commissionRateBps: 500, marketerId: marketer!.id } });
    await expect(logCommissionStrike(prisma, { sellerId: lowSeller.id, now: first })).rejects.toThrow(
      'commission dispute is not available for this rate'
    );
  });

  it('counts coupon treasury-held coupons through issuance in solvency obligations', async () => {
    const fixtureAccounts = await fixture(1);
    await prisma.ledgerAccount.update({ where: { id: fixtureAccounts.issuance }, data: { balance: -100n } });
    await prisma.ledgerAccount.update({ where: { id: fixtureAccounts.couponFees }, data: { balance: 10n } });
    await expect(readSolvency(prisma)).resolves.toMatchObject({ obligationsMicroUsdt: 1_000_000n });
  });

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
    expect(dustOnly.roundingDustMicroUsdt).toBe(5_679n);
    expect(await prisma.ledgerEntry.count({ where: { transactionId: dustOnly.id } })).toBe(1);
  });

  it('carries dust across deposits and mints when the carry reaches a coupon', async () => {
    const fixtureAccounts = await fixture(1);
    const user = await prisma.user.findFirstOrThrow();
    const deposit = (externalRef: string, amountMicroUsdt: bigint) => postDeposit(prisma, {
      externalRef,
      userId: user.id,
      userCouponAccountId: fixtureAccounts.users[0]!,
      externalOnchainAccountId: fixtureAccounts.external,
      vaultAccountId: fixtureAccounts.vault,
      issuanceAccountId: fixtureAccounts.issuance,
      amountMicroUsdt,
    });
    await expect(deposit('deposit:dust:0', 5_000n)).resolves.toMatchObject({ amountCoupons: 0n, roundingDustMicroUsdt: 5_000n });
    await expect(deposit('deposit:dust:1', 5_000n)).resolves.toMatchObject({ amountCoupons: 1n, roundingDustMicroUsdt: 0n });
    expect((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: fixtureAccounts.users[0]! } })).balance).toBe(1n);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).dustMicroUsdt).toBe(0n);
  });

  it('preserves the deposit equation for randomized amounts and carry', async () => {
    const fixtureAccounts = await fixture(1);
    const user = await prisma.user.findFirstOrThrow();
    let totalDeposited = 0n;
    let totalMinted = 0n;
    for (let index = 0; index < 100; index += 1) {
      const amount = BigInt((index * 7919) % 100_000 + 1);
      const transaction = await postDeposit(prisma, {
        externalRef: `deposit:random:${index}`,
        userId: user.id,
        userCouponAccountId: fixtureAccounts.users[0]!,
        externalOnchainAccountId: fixtureAccounts.external,
        vaultAccountId: fixtureAccounts.vault,
        issuanceAccountId: fixtureAccounts.issuance,
        amountMicroUsdt: amount,
      });
      totalDeposited += amount;
      totalMinted += transaction.amountCoupons;
    }
    const carry = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).dustMicroUsdt;
    expect(totalMinted * 10_000n + carry).toBe(totalDeposited);
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

  it('blocks outgoing value during PIN reset quarantine and restores it after expiry', async () => {
    const fixtureAccounts = await fixture(2);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: (await prisma.user.findFirstOrThrow()).id } });
    await postDeposit(prisma, {
      externalRef: 'deposit:quarantine:0',
      userId: user.id,
      userCouponAccountId: fixtureAccounts.users[0]!,
      externalOnchainAccountId: fixtureAccounts.external,
      vaultAccountId: fixtureAccounts.vault,
      issuanceAccountId: fixtureAccounts.issuance,
      amountMicroUsdt: 1_000_000_000n,
    });
    await prisma.user.update({ where: { id: user.id }, data: { pinResetQuarantineUntil: new Date(Date.now() + 60_000) } });
    await expect(readWithdrawalAvailability(prisma, user.id)).resolves.toMatchObject({ blockers: ['pin_reset_quarantine'] });
    await expect(transferCoupons(prisma, {
      externalRef: 'transfer:quarantine',
      fromAccountId: fixtureAccounts.users[0]!,
      toAccountId: fixtureAccounts.users[1]!,
      amountCoupons: 1n,
      userId: user.id,
    })).rejects.toThrow('account is quarantined');
    await expect(createEscrowHold(prisma, {
      senderId: user.id,
      recipientId: (await prisma.user.findFirstOrThrow({ where: { id: { not: user.id } } })).id,
      senderAccountId: fixtureAccounts.users[0]!,
      escrowAccountId: fixtureAccounts.escrows[0]!,
      amountCoupons: 1n,
      code: '1234',
      expiresAt: new Date(Date.now() + 60_000),
    })).rejects.toThrow('account is quarantined');
    await prisma.user.update({ where: { id: user.id }, data: { pinResetQuarantineUntil: new Date(Date.now() - 1) } });
    await expect(readWithdrawalAvailability(prisma, user.id)).resolves.not.toMatchObject({ blockers: ['pin_reset_quarantine'] });
  });

  it('calculates fee, net, and approval boundaries with integer arithmetic', () => {
    expect(quoteWithdrawalForUsdt(10_000n, { baseFeeBps: 125n, minimumFeeMicroUsdt: 0n, minimumWithdrawalMicroUsdt: 1_000_000n })).toEqual({ grossMicroUsdt: 100_000_000n, feeMicroUsdt: 1_250_000n, netMicroUsdt: 98_750_000n });
    expect(quoteWithdrawalForUsdt(100n, { baseFeeBps: 100n, minimumFeeMicroUsdt: 0n, minimumWithdrawalMicroUsdt: 990_000n }).netMicroUsdt).toBe(990_000n);
    expect(() => quoteWithdrawalForUsdt(100n, { baseFeeBps: 100n, minimumFeeMicroUsdt: 0n, minimumWithdrawalMicroUsdt: 990_001n })).toThrow();
    expect(quoteWithdrawalForUsdt(100n, { baseFeeBps: 100n, minimumFeeMicroUsdt: 20_000n, minimumWithdrawalMicroUsdt: 1n }).feeMicroUsdt).toBe(20_000n);
    expect(quoteWithdrawalForUsdt(10_000n, { baseFeeBps: 100n, minimumFeeMicroUsdt: 2_000n, minimumWithdrawalMicroUsdt: 1n }).feeMicroUsdt).toBe(1_000_000n);
    expect(() => quoteWithdrawalForUsdt(1n, { baseFeeBps: 0n, minimumFeeMicroUsdt: 10_001n, minimumWithdrawalMicroUsdt: 0n })).toThrow('fee must be less than gross');
    expect(() => quoteWithdrawalForUsdt(100n, { baseFeeBps: 0n, minimumFeeMicroUsdt: -1n, minimumWithdrawalMicroUsdt: 0n })).toThrow('minimum fee cannot be negative');
    expect(() => quoteWithdrawalForUsdt(100n, { baseFeeBps: 0n, minimumFeeMicroUsdt: 2_000n, minimumWithdrawalMicroUsdt: 998_001n })).toThrow('withdrawal is below minimum');
  });

  it('restores exact balances on withdrawal refund', async () => {
    const fixtureAccounts = await fixture(1);
    const userId = (await prisma.user.findFirstOrThrow()).id;
    await postDeposit(prisma, { externalRef: 'deposit:withdrawal:0', userId, userCouponAccountId: fixtureAccounts.users[0]!, externalOnchainAccountId: fixtureAccounts.external, vaultAccountId: fixtureAccounts.vault, issuanceAccountId: fixtureAccounts.issuance, amountMicroUsdt: 100_000_000n });
    const before = await prisma.ledgerAccount.findMany({ where: { id: { in: [fixtureAccounts.users[0]!, fixtureAccounts.vault, fixtureAccounts.pending, fixtureAccounts.fees, fixtureAccounts.issuance] } }, orderBy: { id: 'asc' } });
    const withdrawal = await requestWithdrawal(prisma, { userId, userAccountId: fixtureAccounts.users[0]!, destinationAddress: '0x52908400098527886E0F7030069857D2E4169EE7', couponsGross: 1_000n, baseFeeBps: 100n, minimumFeeMicroUsdt: 0n, minimumWithdrawalMicroUsdt: 1n, autoApprovalLimitMicroUsdt: 1_000_000_000n, vaultAccountId: fixtureAccounts.vault, feeAccountId: fixtureAccounts.fees, pendingAccountId: fixtureAccounts.pending, issuanceAccountId: fixtureAccounts.issuance, cooldownHours: 0 });
    await refundWithdrawal(prisma, { withdrawalId: withdrawal.id, userAccountId: fixtureAccounts.users[0]!, vaultAccountId: fixtureAccounts.vault, feeAccountId: fixtureAccounts.fees, pendingAccountId: fixtureAccounts.pending, issuanceAccountId: fixtureAccounts.issuance });
    const after = await prisma.ledgerAccount.findMany({ where: { id: { in: [fixtureAccounts.users[0]!, fixtureAccounts.vault, fixtureAccounts.pending, fixtureAccounts.fees, fixtureAccounts.issuance] } }, orderBy: { id: 'asc' } });
    expect(after.map((item) => item.balance)).toEqual(before.map((item) => item.balance));
    expect((await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } })).status).toBe(WithdrawalStatus.REFUNDED);
  });

  it.each([
    ['PROCESSING', WithdrawalStatus.PROCESSING, null],
    ['COMPLETED', WithdrawalStatus.COMPLETED, null],
    ['FAILED with chain hash', WithdrawalStatus.FAILED, '0xdeadbeef'],
  ])('rejects unsafe withdrawal refund: %s', async (_label, status, chainTxHash) => {
    const fixtureAccounts = await fixture(1);
    const userId = (await prisma.user.findFirstOrThrow()).id;
    await postDeposit(prisma, { externalRef: `deposit:unsafe:${String(status)}`, userId, userCouponAccountId: fixtureAccounts.users[0]!, externalOnchainAccountId: fixtureAccounts.external, vaultAccountId: fixtureAccounts.vault, issuanceAccountId: fixtureAccounts.issuance, amountMicroUsdt: 100_000_000n });
    const withdrawal = await requestWithdrawal(prisma, { userId, userAccountId: fixtureAccounts.users[0]!, destinationAddress: '0x52908400098527886E0F7030069857D2E4169EE7', couponsGross: 1_000n, baseFeeBps: 100n, minimumFeeMicroUsdt: 0n, minimumWithdrawalMicroUsdt: 1n, autoApprovalLimitMicroUsdt: 0n, vaultAccountId: fixtureAccounts.vault, feeAccountId: fixtureAccounts.fees, pendingAccountId: fixtureAccounts.pending, issuanceAccountId: fixtureAccounts.issuance, cooldownHours: 0 });
    await prisma.withdrawal.update({ where: { id: withdrawal.id }, data: { status, ...(chainTxHash === null ? {} : { chainTxHash }) } });
    await expect(refundWithdrawal(prisma, { withdrawalId: withdrawal.id, userAccountId: fixtureAccounts.users[0]!, vaultAccountId: fixtureAccounts.vault, feeAccountId: fixtureAccounts.fees, pendingAccountId: fixtureAccounts.pending, issuanceAccountId: fixtureAccounts.issuance })).rejects.toThrow('cannot be refunded');
  });

  it('rejects an approval withdrawal through the same refund posting', async () => {
    const fixtureAccounts = await fixture(1);
    const userId = (await prisma.user.findFirstOrThrow()).id;
    await postDeposit(prisma, { externalRef: 'deposit:rejected:0', userId, userCouponAccountId: fixtureAccounts.users[0]!, externalOnchainAccountId: fixtureAccounts.external, vaultAccountId: fixtureAccounts.vault, issuanceAccountId: fixtureAccounts.issuance, amountMicroUsdt: 100_000_000n });
    const before = await prisma.ledgerAccount.findMany({ where: { id: { in: [fixtureAccounts.users[0]!, fixtureAccounts.vault, fixtureAccounts.pending, fixtureAccounts.fees, fixtureAccounts.issuance] } }, orderBy: { id: 'asc' } });
    const withdrawal = await requestWithdrawal(prisma, { userId, userAccountId: fixtureAccounts.users[0]!, destinationAddress: '0x52908400098527886E0F7030069857D2E4169EE7', couponsGross: 1_000n, baseFeeBps: 100n, minimumFeeMicroUsdt: 0n, minimumWithdrawalMicroUsdt: 1n, autoApprovalLimitMicroUsdt: 1_000_000_000n, vaultAccountId: fixtureAccounts.vault, feeAccountId: fixtureAccounts.fees, pendingAccountId: fixtureAccounts.pending, issuanceAccountId: fixtureAccounts.issuance, cooldownHours: 0 });
    await rejectWithdrawal(prisma, { withdrawalId: withdrawal.id, userAccountId: fixtureAccounts.users[0]!, vaultAccountId: fixtureAccounts.vault, feeAccountId: fixtureAccounts.fees, pendingAccountId: fixtureAccounts.pending, issuanceAccountId: fixtureAccounts.issuance });
    const after = await prisma.ledgerAccount.findMany({ where: { id: { in: [fixtureAccounts.users[0]!, fixtureAccounts.vault, fixtureAccounts.pending, fixtureAccounts.fees, fixtureAccounts.issuance] } }, orderBy: { id: 'asc' } });
    expect(after.map((item) => item.balance)).toEqual(before.map((item) => item.balance));
    expect((await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } })).status).toBe(WithdrawalStatus.REJECTED);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: withdrawal.transactionId } })).status).toBe(TransactionStatus.REJECTED);
    expect((await prisma.transaction.findFirstOrThrow({ where: { type: 'REFUND' } })).status).toBe(TransactionStatus.CONFIRMED);
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

  it('allows only one concurrent escrow release or cancellation', async () => {
    const fixtureAccounts = await fixture(2);
    const users = await prisma.user.findMany({ orderBy: { barcodeId: 'asc' } });
    await postDeposit(prisma, { externalRef: 'deposit:escrow-race:0', userId: users[0]!.id, userCouponAccountId: fixtureAccounts.users[0]!, externalOnchainAccountId: fixtureAccounts.external, vaultAccountId: fixtureAccounts.vault, issuanceAccountId: fixtureAccounts.issuance, amountMicroUsdt: 1_000_000n });
    const hold = await createEscrowHold(prisma, { senderId: users[0]!.id, recipientId: users[1]!.id, senderAccountId: fixtureAccounts.users[0]!, escrowAccountId: fixtureAccounts.escrows[0]!, amountCoupons: 10n, code: '1234', expiresAt: new Date(Date.now() + 60_000) });
    const clients = [new PrismaClient(), new PrismaClient()];
    try {
      const outcomes = await Promise.allSettled([
        releaseEscrow(clients[0]!, { holdId: hold.id, recipientAccountId: fixtureAccounts.users[1]!, code: '1234' }),
        cancelEscrow(clients[1]!, { holdId: hold.id, senderAccountId: fixtureAccounts.users[0]! }),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
      const balances = await prisma.ledgerAccount.findMany({ where: { id: { in: [fixtureAccounts.users[0]!, fixtureAccounts.users[1]!, fixtureAccounts.escrows[0]!] } } });
      expect(balances.filter((account) => account.id !== fixtureAccounts.escrows[0]!).reduce((sum, account) => sum + account.balance, 0n)).toBe(100n);
      expect(balances.find((account) => account.id === fixtureAccounts.escrows[0]!)?.balance).toBe(0n);
      expect(await prisma.ledgerEntry.count({ where: { amount: 10n } })).toBe(2);
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  });

  it('reports coupon and dust liabilities against USDT assets', () => {
    expect(calculateSolvency({
      issuanceBalance: -100n,
      totalDustMicroUsdt: 5_000n,
      vaultBalance: 900_000n,
      withdrawalPendingBalance: 105_000n,
      feeBalance: 25_000n,
    })).toEqual({
      custodyMicroUsdt: 1_030_000n,
      obligationsMicroUsdt: 1_110_000n,
      surplusMicroUsdt: -80_000n,
      isSolvent: false,
    });
  });

  it('does not count an in-flight withdrawal as surplus', () => {
    expect(calculateSolvency({
      issuanceBalance: -100n,
      totalDustMicroUsdt: 0n,
      vaultBalance: 1_000_000n,
      withdrawalPendingBalance: 500_000n,
      feeBalance: 0n,
    })).toEqual({
      custodyMicroUsdt: 1_500_000n,
      obligationsMicroUsdt: 1_500_000n,
      surplusMicroUsdt: 0n,
      isSolvent: true,
    });
  });

  it('keeps demo issuance outside real solvency and tracks it separately', async () => {
    const fixtureAccounts = await fixture(1);
    const demoUser = await prisma.user.create({ data: { phoneNumber: '+9900000000001', barcodeId: 'demo-1', isDemo: true } });
    const demoAccount = await account(AccountType.USER_COUPON, Asset.COUPON, demoUser.id);
    const demoIssuance = await account(AccountType.SYSTEM_DEMO_ISSUANCE, Asset.COUPON);
    const before = await readSolvency(prisma);
    const transaction = await issueDemoCoupons(prisma, {
      userId: demoUser.id,
      userCouponAccountId: demoAccount.id,
      demoIssuanceAccountId: demoIssuance.id,
      amountCoupons: 7n,
      externalRef: 'demo:test:issue',
    });
    expect(transaction.type).toBe('DEMO_ISSUE');
    expect(await readDemoCirculation(prisma)).toBe(7n);
    expect(await readSolvency(prisma)).toEqual(before);
    await expect(transferCoupons(prisma, {
      userId: demoUser.id,
      counterpartyUserId: (await prisma.user.findFirstOrThrow({ where: { isDemo: false } })).id,
      fromAccountId: demoAccount.id,
      toAccountId: fixtureAccounts.users[0]!,
      amountCoupons: 1n,
      externalRef: 'demo:test:mixed-transfer',
    })).rejects.toThrow('demo and real accounts cannot exchange coupons');
  });

  it('reconciles demo issuance after a partial purge', async () => {
    const first = await prisma.user.create({ data: { phoneNumber: '+9900000000001', barcodeId: 'demo-1', isDemo: true } });
    const second = await prisma.user.create({ data: { phoneNumber: '+9900000000002', barcodeId: 'demo-2', isDemo: true } });
    const firstAccount = await account(AccountType.USER_COUPON, Asset.COUPON, first.id);
    const secondAccount = await account(AccountType.USER_COUPON, Asset.COUPON, second.id);
    const demoIssuance = await account(AccountType.SYSTEM_DEMO_ISSUANCE, Asset.COUPON);
    await issueDemoCoupons(prisma, { userId: first.id, userCouponAccountId: firstAccount.id, demoIssuanceAccountId: demoIssuance.id, amountCoupons: 3n, externalRef: 'demo:purge:first' });
    await issueDemoCoupons(prisma, { userId: second.id, userCouponAccountId: secondAccount.id, demoIssuanceAccountId: demoIssuance.id, amountCoupons: 5n, externalRef: 'demo:purge:second' });
    await prisma.$transaction(async (tx) => {
      await tx.ledgerEntry.deleteMany({ where: { OR: [{ fromAccountId: firstAccount.id }, { toAccountId: firstAccount.id }] } });
      await tx.transaction.deleteMany({ where: { userId: first.id } });
      await tx.ledgerAccount.delete({ where: { id: firstAccount.id } });
      await tx.user.delete({ where: { id: first.id } });
      expect(await reconcileDemoIssuance(tx, 3n)).toBe(-5n);
    });
    expect(await readDemoCirculation(prisma)).toBe(5n);
  });

  it('rejects an incorrect purged demo balance during reconciliation', async () => {
    const first = await prisma.user.create({ data: { phoneNumber: '+9900000000001', barcodeId: 'demo-1', isDemo: true } });
    const second = await prisma.user.create({ data: { phoneNumber: '+9900000000002', barcodeId: 'demo-2', isDemo: true } });
    const firstAccount = await account(AccountType.USER_COUPON, Asset.COUPON, first.id);
    const secondAccount = await account(AccountType.USER_COUPON, Asset.COUPON, second.id);
    const demoIssuance = await account(AccountType.SYSTEM_DEMO_ISSUANCE, Asset.COUPON);
    await issueDemoCoupons(prisma, { userId: first.id, userCouponAccountId: firstAccount.id, demoIssuanceAccountId: demoIssuance.id, amountCoupons: 3n, externalRef: 'demo:purge:wrong:first' });
    await issueDemoCoupons(prisma, { userId: second.id, userCouponAccountId: secondAccount.id, demoIssuanceAccountId: demoIssuance.id, amountCoupons: 5n, externalRef: 'demo:purge:wrong:second' });
    await expect(prisma.$transaction(async (tx) => {
      await tx.ledgerEntry.deleteMany({ where: { OR: [{ fromAccountId: firstAccount.id }, { toAccountId: firstAccount.id }] } });
      await tx.transaction.deleteMany({ where: { userId: first.id } });
      await tx.ledgerAccount.delete({ where: { id: firstAccount.id } });
      await tx.user.delete({ where: { id: first.id } });
      await reconcileDemoIssuance(tx, 2n);
    })).rejects.toThrow('previous issuance');
    expect((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: demoIssuance.id } })).balance).toBe(-8n);
  });
});

describe('prepaid USDT escrow', () => {
  it('settles directed pay codes with the stored amount and isolates the merchant', async () => {
    const fixtureAccounts = await fixture(3);
    const users = await prisma.user.findMany({ orderBy: { barcodeId: 'asc' } });
    await prisma.escrowBalance.create({ data: { userId: users[0]!.id, lockedMicroUsdt: 2_000_000n } });
    const code = await createPayCode(prisma, { buyerId: users[0]!.id, merchantId: users[1]!.id, amountMicroUsdt: 750_000n, code: '1234', maxAmountMicroUsdt: 750_000n, expiresAt: new Date(Date.now() + 60_000) });
    await expect(settleDirectedPayCode(prisma, { merchantId: users[2]!.id, payCodeId: code.id, code: '1234' })).rejects.toThrow(/pay code not found/);
    await expect(settleWithPayCode(prisma, { merchantId: users[2]!.id, buyerBarcodeId: users[0]!.barcodeId, code: '1234', amountMicroUsdt: 750_000n })).rejects.toThrow();
    const settled = await settleDirectedPayCode(prisma, { merchantId: users[1]!.id, payCodeId: code.id, code: '1234' });
    expect(settled.settlement.amountMicroUsdt).toBe(750_000n);
    expect((await prisma.payCode.findUniqueOrThrow({ where: { id: code.id } })).status).toBe('USED');
    expect((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: fixtureAccounts.users[1]! } })).balance).toBe(75n);
    expect((await prisma.escrowBalance.findUniqueOrThrow({ where: { userId: users[0]!.id } })).reservedMicroUsdt).toBe(750_000n);
  });

  it('cancels directed pay codes on the third wrong code', async () => {
    await fixture(2);
    const users = await prisma.user.findMany({ orderBy: { barcodeId: 'asc' } });
    await prisma.escrowBalance.create({ data: { userId: users[0]!.id, lockedMicroUsdt: 1_000_000n } });
    const code = await createPayCode(prisma, { buyerId: users[0]!.id, merchantId: users[1]!.id, amountMicroUsdt: 100_000n, code: '1234', maxAmountMicroUsdt: 100_000n, expiresAt: new Date(Date.now() + 60_000) });
    for (let attempt = 0; attempt < 3; attempt += 1) await expect(settleDirectedPayCode(prisma, { merchantId: users[1]!.id, payCodeId: code.id, code: '0000' })).rejects.toThrow();
    expect((await prisma.payCode.findUniqueOrThrow({ where: { id: code.id } })).status).toBe('CANCELLED');
  });

  it('locks out a pay code after three wrong attempts and rejects expiry/over-amount', async () => {
    const fixtureAccounts = await fixture(2);
    const users = await prisma.user.findMany({ orderBy: { barcodeId: 'asc' } });
    await prisma.escrowBalance.create({ data: { userId: users[0]!.id, lockedMicroUsdt: 2_000_000n } });
    const code = await createPayCode(prisma, { buyerId: users[0]!.id, code: '1234', maxAmountMicroUsdt: 1_000_000n, expiresAt: new Date(Date.now() + 60_000) });
    for (let attempt = 0; attempt < 3; attempt += 1) await expect(settleWithPayCode(prisma, { merchantId: users[1]!.id, buyerBarcodeId: users[0]!.barcodeId, code: '0000', amountMicroUsdt: 100_000n })).rejects.toThrow();
    expect((await prisma.payCode.findUniqueOrThrow({ where: { id: code.id } })).status).toBe('CANCELLED');
    await expect(createPayCode(prisma, { buyerId: users[0]!.id, code: '1111', maxAmountMicroUsdt: 2_000_001n, expiresAt: new Date(Date.now() + 60_000) })).rejects.toThrow();
    const expired = await createPayCode(prisma, { buyerId: users[0]!.id, code: '2222', maxAmountMicroUsdt: 100_000n, expiresAt: new Date(Date.now() + 60_000) });
    await prisma.payCode.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    await expect(settleWithPayCode(prisma, { merchantId: users[1]!.id, buyerBarcodeId: users[0]!.barcodeId, code: '2222', amountMicroUsdt: 100_000n })).rejects.toThrow(/expired/);
    expect(fixtureAccounts.users).toHaveLength(2);
  });

  it('prevents double spend, confirms idempotently, and releases reservation on failure', async () => {
    const fixtureAccounts = await fixture(2);
    const users = await prisma.user.findMany({ orderBy: { barcodeId: 'asc' } });
    await prisma.escrowBalance.create({ data: { userId: users[0]!.id, lockedMicroUsdt: 2_000_000n } });
    await createPayCode(prisma, { buyerId: users[0]!.id, code: '1234', maxAmountMicroUsdt: 1_000_000n, expiresAt: new Date(Date.now() + 60_000) });
    const result = await settleWithPayCode(prisma, { merchantId: users[1]!.id, buyerBarcodeId: users[0]!.barcodeId, code: '1234', amountMicroUsdt: 1_000_000n });
    await expect(createPayCode(prisma, { buyerId: users[0]!.id, code: '5678', maxAmountMicroUsdt: 1_000_001n, expiresAt: new Date(Date.now() + 60_000) })).rejects.toThrow();
    const confirmed = await confirmSettlement(prisma, { ref: result.settlement.ref, txHash: '0xsettle' });
    expect((await confirmSettlement(prisma, { ref: result.settlement.ref, txHash: '0xother' })).id).toBe(confirmed.id);
    expect((await prisma.escrowBalance.findUniqueOrThrow({ where: { userId: users[0]!.id } })).lockedMicroUsdt).toBe(1_000_000n);
    expect(fixtureAccounts.issuance).toBeTruthy();
    await createPayCode(prisma, { buyerId: users[0]!.id, code: '9999', maxAmountMicroUsdt: 500_000n, expiresAt: new Date(Date.now() + 60_000) });
    const pending = await settleWithPayCode(prisma, { merchantId: users[1]!.id, buyerBarcodeId: users[0]!.barcodeId, code: '9999', amountMicroUsdt: 500_000n });
    const failed = await failSettlement(prisma, { settlementId: pending.settlement.id, error: 'retryable failure' });
    expect(failed.status).toBe('FAILED');
    expect((await prisma.escrowBalance.findUniqueOrThrow({ where: { userId: users[0]!.id } })).reservedMicroUsdt).toBe(0n);
  });

  it('reserves unloads, confirms them idempotently, and releases failed reservations', async () => {
    const fixtureAccounts = await fixture(1);
    const user = await prisma.user.findFirstOrThrow();
    await prisma.memberWallet.create({ data: { userId: user.id, address: '0x0000000000000000000000000000000000000001', kind: 'EXTERNAL', chainId: 137 } });
    await prisma.escrowBalance.create({ data: { userId: user.id, lockedMicroUsdt: 2_000_000n } });
    const unload = await requestUnload(prisma, { userId: user.id, amountMicroUsdt: 750_000n });
    expect(await prisma.escrowBalance.findUniqueOrThrow({ where: { userId: user.id } })).toMatchObject({ lockedMicroUsdt: 2_000_000n, reservedMicroUsdt: 750_000n });
    const confirmed = await confirmUnload(prisma, { ref: unload.ref, txHash: '0xunload' });
    expect(confirmed.status).toBe('CONFIRMED');
    await expect(confirmUnload(prisma, { ref: unload.ref, txHash: '0xother' })).resolves.toMatchObject({ id: unload.id });
    expect(await prisma.escrowBalance.findUniqueOrThrow({ where: { userId: user.id } })).toMatchObject({ lockedMicroUsdt: 1_250_000n, reservedMicroUsdt: 0n });
    const failedUnload = await requestUnload(prisma, { userId: user.id, amountMicroUsdt: 250_000n });
    await expect(failUnload(prisma, { unloadId: failedUnload.id, error: 'temporary failure' })).resolves.toMatchObject({ status: 'FAILED' });
    expect(await prisma.escrowBalance.findUniqueOrThrow({ where: { userId: user.id } })).toMatchObject({ lockedMicroUsdt: 1_250_000n, reservedMicroUsdt: 0n });
    expect(fixtureAccounts.users).toHaveLength(1);
  });

  it('reconciles settlement and unload events idempotently and records unknown references', async () => {
    await fixture(2);
    const users = await prisma.user.findMany({ orderBy: { barcodeId: 'asc' } });
    await prisma.escrowBalance.create({ data: { userId: users[0]!.id, lockedMicroUsdt: 2_000_000n } });
    await createPayCode(prisma, { buyerId: users[0]!.id, code: '1234', maxAmountMicroUsdt: 1_000_000n, expiresAt: new Date(Date.now() + 60_000) });
    const settlement = await settleWithPayCode(prisma, { merchantId: users[1]!.id, buyerBarcodeId: users[0]!.barcodeId, code: '1234', amountMicroUsdt: 600_000n });
    const settleEvent = { kind: EscrowEventKind.SETTLE, txHash: '0xsettle-event', logIndex: 0, blockNumber: 1n, walletAddress: '0x0000000000000000000000000000000000000001', amountMicroUsdt: 600_000n, ref: settlement.settlement.ref };
    await applyEscrowChainEvent(prisma, settleEvent);
    await applyEscrowChainEvent(prisma, settleEvent);
    expect(await prisma.escrowChainEvent.count({ where: { txHash: settleEvent.txHash } })).toBe(1);
    expect((await prisma.escrowChainEvent.findUniqueOrThrow({ where: { txHash_logIndex: { txHash: settleEvent.txHash, logIndex: 0 } } })).reconciledAt).toBeInstanceOf(Date);
    expect((await prisma.escrowSettlement.findUniqueOrThrow({ where: { id: settlement.settlement.id } })).status).toBe('CONFIRMED');
    expect((await prisma.escrowBalance.findUniqueOrThrow({ where: { userId: users[0]!.id } })).lockedMicroUsdt).toBe(1_400_000n);

    await prisma.memberWallet.create({ data: { userId: users[0]!.id, address: '0x0000000000000000000000000000000000000002', kind: 'EXTERNAL', chainId: 137 } });
    const unload = await requestUnload(prisma, { userId: users[0]!.id, amountMicroUsdt: 400_000n });
    const unloadEvent = { kind: EscrowEventKind.UNLOAD, txHash: '0xunload-event', logIndex: 0, blockNumber: 2n, walletAddress: unload.walletAddress, amountMicroUsdt: 400_000n, ref: unload.ref };
    await applyEscrowChainEvent(prisma, unloadEvent);
    await applyEscrowChainEvent(prisma, unloadEvent);
    expect(await prisma.escrowChainEvent.count({ where: { txHash: unloadEvent.txHash } })).toBe(1);
    expect((await prisma.escrowChainEvent.findUniqueOrThrow({ where: { txHash_logIndex: { txHash: unloadEvent.txHash, logIndex: 0 } } })).reconciledAt).toBeInstanceOf(Date);
    expect((await prisma.escrowUnload.findUniqueOrThrow({ where: { id: unload.id } })).status).toBe('CONFIRMED');
    expect((await prisma.escrowBalance.findUniqueOrThrow({ where: { userId: users[0]!.id } })).lockedMicroUsdt).toBe(1_000_000n);

    const unknown = { kind: EscrowEventKind.SETTLE, txHash: '0xunknown-event', logIndex: 0, blockNumber: 3n, walletAddress: unload.walletAddress, amountMicroUsdt: 1n, ref: '0x' + 'ff'.repeat(32) };
    await expect(applyEscrowChainEvent(prisma, unknown)).resolves.toMatchObject({ txHash: unknown.txHash, reconciledAt: null });
    expect(await prisma.escrowChainEvent.count({ where: { txHash: unknown.txHash } })).toBe(1);
    expect((await prisma.escrowBalance.findUniqueOrThrow({ where: { userId: users[0]!.id } })).lockedMicroUsdt).toBe(1_000_000n);
  });

  it('reverses settlement dust using the merchant current balance', async () => {
    const fixtureAccounts = await fixture(2);
    const users = await prisma.user.findMany({ orderBy: { barcodeId: 'asc' } });
    await prisma.escrowBalance.create({ data: { userId: users[0]!.id, lockedMicroUsdt: 2_000_000n } });
    await createPayCode(prisma, { buyerId: users[0]!.id, code: '1234', maxAmountMicroUsdt: 100_000n, expiresAt: new Date(Date.now() + 60_000) });
    const settlement = await settleWithPayCode(prisma, { merchantId: users[1]!.id, buyerBarcodeId: users[0]!.barcodeId, code: '1234', amountMicroUsdt: 15_000n });
    await postDeposit(prisma, {
      externalRef: 'deposit:interleaved-dust',
      userId: users[1]!.id,
      userCouponAccountId: fixtureAccounts.users[1]!,
      externalOnchainAccountId: fixtureAccounts.external,
      vaultAccountId: fixtureAccounts.vault,
      issuanceAccountId: fixtureAccounts.issuance,
      amountMicroUsdt: 1_000n,
    });
    const failed = await failSettlement(prisma, { settlementId: settlement.settlement.id, error: 'provider failure' });
    expect(failed.status).toBe('FAILED');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: users[1]!.id } })).dustMicroUsdt).toBe(1_000n);
    expect((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: fixtureAccounts.users[1]! } })).balance).toBe(0n);
  });

  it('records chain events idempotently and preserves unknown deposits', async () => {
    const fixtureAccounts = await fixture(1);
    const user = await prisma.user.findFirstOrThrow();
    const wallet = await prisma.memberWallet.create({ data: { userId: user.id, address: '0x0000000000000000000000000000000000000001', kind: 'EXTERNAL', chainId: 137 } });
    const event = { kind: EscrowEventKind.DEPOSIT, txHash: '0xdeposit', logIndex: 0, blockNumber: 1n, walletAddress: wallet.address, amountMicroUsdt: 123n };
    await applyEscrowChainEvent(prisma, event);
    await applyEscrowChainEvent(prisma, event);
    expect(await prisma.escrowChainEvent.count()).toBe(1);
    expect((await prisma.escrowBalance.findUniqueOrThrow({ where: { userId: user.id } })).lockedMicroUsdt).toBe(123n);
    expect(fixtureAccounts.users).toHaveLength(1);
  });

  it('settles beneficiary pay codes against a charity purchase guarantee', async () => {
    await fixture(3);
    const users = await prisma.user.findMany({ orderBy: { barcodeId: 'asc' } });
    const beneficiary = users[0]!;
    const merchant = users[1]!;
    const agent = users[2]!;
    await prisma.escrowBalance.create({ data: { userId: agent.id, lockedMicroUsdt: 10_000_000n } });
    const charity = await prisma.charity.create({ data: { name: 'Guarantee Help' } });
    await prisma.charityAgent.create({ data: { charityId: charity.id, userId: agent.id, role: CharityAgentRole.AGENT } });
    const request = await createAidRequest(prisma, { applicantId: beneficiary.id, charityId: charity.id, amountCoupons: 500n, description: 'food' });
    const approved = await approveAidRequest(prisma, { aidRequestId: request.id, agentId: agent.id, mode: 'GUARANTEE' });
    expect(approved.status).toBe('GUARANTEED');
    const guarantee = await prisma.purchaseGuarantee.findUniqueOrThrow({ where: { aidRequestId: request.id } });
    expect(guarantee.remainingMicroUsdt).toBe(5_000_000n);
    expect((await prisma.escrowBalance.findUniqueOrThrow({ where: { userId: agent.id } })).reservedMicroUsdt).toBe(5_000_000n);

    const payCode = await createPayCode(prisma, { buyerId: beneficiary.id, code: '1234', maxAmountMicroUsdt: 30_000n, merchantId: merchant.id, amountMicroUsdt: 30_000n, expiresAt: new Date(Date.now() + 60_000) });
    expect(payCode.guaranteeId).toBe(guarantee.id);
    const settlement = await settleWithPayCode(prisma, { merchantId: merchant.id, buyerBarcodeId: beneficiary.barcodeId, code: '1234', amountMicroUsdt: 30_000n });
    expect(settlement.settlement.payerId).toBe(agent.id);
    expect((await prisma.purchaseGuarantee.findUniqueOrThrow({ where: { id: guarantee.id } })).remainingMicroUsdt).toBe(4_970_000n);
    expect((await prisma.escrowBalance.findUniqueOrThrow({ where: { userId: agent.id } })).reservedMicroUsdt).toBe(5_000_000n);
    await confirmSettlement(prisma, { ref: settlement.settlement.ref, txHash: '0xguaranteed' });
    expect(await prisma.escrowBalance.findUniqueOrThrow({ where: { userId: agent.id } })).toMatchObject({ lockedMicroUsdt: 9_970_000n, reservedMicroUsdt: 4_970_000n });

    const second = await createPayCode(prisma, { buyerId: beneficiary.id, code: '5678', maxAmountMicroUsdt: 30_000n, merchantId: merchant.id, amountMicroUsdt: 30_000n, expiresAt: new Date(Date.now() + 60_000) });
    const failedSettlement = await settleWithPayCode(prisma, { merchantId: merchant.id, buyerBarcodeId: beneficiary.barcodeId, code: '5678', amountMicroUsdt: 30_000n });
    await failSettlement(prisma, { settlementId: failedSettlement.settlement.id, error: 'provider failure' });
    expect((await prisma.purchaseGuarantee.findUniqueOrThrow({ where: { id: guarantee.id } })).remainingMicroUsdt).toBe(4_970_000n);
    await expect(createPayCode(prisma, { buyerId: beneficiary.id, code: '9999', maxAmountMicroUsdt: 5_000_000n, expiresAt: new Date(Date.now() + 60_000) })).rejects.toThrow('pay code exceeds available escrow');
    await revokePurchaseGuarantee(prisma, { guaranteeId: guarantee.id, agentId: agent.id });
    expect((await prisma.purchaseGuarantee.findUniqueOrThrow({ where: { id: guarantee.id } })).status).toBe('REVOKED');
    expect((await prisma.escrowBalance.findUniqueOrThrow({ where: { userId: agent.id } })).reservedMicroUsdt).toBe(0n);
    expect(second.guaranteeId).toBe(guarantee.id);
    await expect(createPayCode(prisma, { buyerId: beneficiary.id, code: '0000', maxAmountMicroUsdt: 30_000n, expiresAt: new Date(Date.now() + 60_000) })).rejects.toThrow('pay code exceeds available escrow');
  });

  it('does not reopen a guarantee revoked while its settlement is pending', async () => {
    await fixture(3);
    const users = await prisma.user.findMany({ orderBy: { barcodeId: 'asc' } });
    const beneficiary = users[0]!;
    const merchant = users[1]!;
    const agent = users[2]!;
    await prisma.escrowBalance.create({ data: { userId: agent.id, lockedMicroUsdt: 10_000_000n } });
    const charity = await prisma.charity.create({ data: { name: 'Revocation Help' } });
    await prisma.charityAgent.create({ data: { charityId: charity.id, userId: agent.id, role: CharityAgentRole.AGENT } });
    const request = await createAidRequest(prisma, { applicantId: beneficiary.id, charityId: charity.id, amountCoupons: 500n, description: 'food' });
    await approveAidRequest(prisma, { aidRequestId: request.id, agentId: agent.id, mode: 'GUARANTEE' });
    const guarantee = await prisma.purchaseGuarantee.findUniqueOrThrow({ where: { aidRequestId: request.id } });
    const payCode = await createPayCode(prisma, { buyerId: beneficiary.id, code: '1234', maxAmountMicroUsdt: 30_000n, merchantId: merchant.id, amountMicroUsdt: 30_000n, expiresAt: new Date(Date.now() + 60_000) });
    expect(payCode.guaranteeId).toBe(guarantee.id);
    const settlement = await settleWithPayCode(prisma, { merchantId: merchant.id, buyerBarcodeId: beneficiary.barcodeId, code: '1234', amountMicroUsdt: 30_000n });
    await revokePurchaseGuarantee(prisma, { guaranteeId: guarantee.id, agentId: agent.id });
    const revoked = await prisma.purchaseGuarantee.findUniqueOrThrow({ where: { id: guarantee.id } });
    expect(revoked.status).toBe('REVOKED');
    expect(revoked.remainingMicroUsdt).toBe(4_970_000n);
    expect((await prisma.escrowBalance.findUniqueOrThrow({ where: { userId: agent.id } })).reservedMicroUsdt).toBe(30_000n);
    await failSettlement(prisma, { settlementId: settlement.settlement.id, error: 'provider failure' });
    const restored = await prisma.purchaseGuarantee.findUniqueOrThrow({ where: { id: guarantee.id } });
    expect(restored.status).toBe('REVOKED');
    expect(restored.remainingMicroUsdt).toBe(4_970_000n);
    expect((await prisma.escrowBalance.findUniqueOrThrow({ where: { userId: agent.id } })).reservedMicroUsdt).toBe(0n);
  });
});
