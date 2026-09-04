import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccountType, AidRequestStatus, Asset, CharityAgentRole, PrismaClient, TransactionType } from '@trustme/db';
import {
  approveAidRequest,
  approveRefund,
  createAidRequest,
  createEscrowHold,
  createRefundRequest,
  donateToCharity,
  postDeposit,
  readSolvency,
  releaseEscrow,
  transferCoupons,
} from '../src/index.js';

const prisma = new PrismaClient();

async function account(type: AccountType, asset: Asset, userId?: string, charityId?: string) {
  return prisma.ledgerAccount.create({ data: { type, asset, ...(userId === undefined ? {} : { userId }), ...(charityId === undefined ? {} : { charityId }) } });
}

beforeAll(async () => prisma.$connect());
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "MediaAsset", "RefundRequest", "AidRequest", "CharityAgent", "Charity", "AdminAuditLog", "AdminUser", "Withdrawal", "EscrowHold", "EmailVerification", "MemberDevice", "Contact", "LoanInstallment", "Guarantee", "Loan", "LedgerEntry", "Transaction", "LedgerAccount", "DepositAddress", "User", "ChainCursor", "SystemSetting" CASCADE');
});
afterAll(async () => prisma.$disconnect());

describe('refunds and charity domain', () => {
  it('posts a balanced refund and accumulates partial approvals', async () => {
    const buyer = await prisma.user.create({ data: { phoneNumber: '+15550001', barcodeId: 'buyer' } });
    const seller = await prisma.user.create({ data: { phoneNumber: '+15550002', barcodeId: 'seller' } });
    const buyerAccount = await account(AccountType.USER_COUPON, Asset.COUPON, buyer.id);
    const sellerAccount = await account(AccountType.USER_COUPON, Asset.COUPON, seller.id);
    const issuance = await account(AccountType.SYSTEM_COUPON_ISSUANCE, Asset.COUPON);
    const external = await account(AccountType.EXTERNAL_ONCHAIN, Asset.USDT);
    const vault = await account(AccountType.SYSTEM_VAULT_USDT, Asset.USDT);
    await account(AccountType.SYSTEM_WITHDRAWAL_PENDING, Asset.USDT);
    await account(AccountType.SYSTEM_FEE_COLLECTION, Asset.USDT);
    await account(AccountType.SYSTEM_FEE_COLLECTION, Asset.COUPON);
    await postDeposit(prisma, { externalRef: 'deposit:refund', userId: buyer.id, userCouponAccountId: buyerAccount.id, externalOnchainAccountId: external.id, vaultAccountId: vault.id, issuanceAccountId: issuance.id, amountMicroUsdt: 1_000_000n });
    const original = await transferCoupons(prisma, { externalRef: 'transfer:refund', fromAccountId: buyerAccount.id, toAccountId: sellerAccount.id, amountCoupons: 100n });
    const solvencyBefore = await readSolvency(prisma);
    const first = await createRefundRequest(prisma, { transactionId: original.id, buyerId: buyer.id, amountCoupons: 40n, reason: 'partial' });
    await approveRefund(prisma, { refundRequestId: first.id, sellerId: seller.id });
    const replay = await approveRefund(prisma, { refundRequestId: first.id, sellerId: seller.id });
    expect(replay.id).toBe(first.id);
    expect(await prisma.transaction.count({ where: { type: TransactionType.REFUND } })).toBe(1);
    const second = await createRefundRequest(prisma, { transactionId: original.id, buyerId: buyer.id, amountCoupons: 60n, reason: 'remaining' });
    await approveRefund(prisma, { refundRequestId: second.id, sellerId: seller.id });
    expect(await readSolvency(prisma)).toEqual(solvencyBefore);
    expect(await prisma.transaction.count({ where: { type: TransactionType.REFUND } })).toBe(2);
    expect((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: sellerAccount.id } })).balance).toBe(0n);
    expect((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: buyerAccount.id } })).balance).toBe(100n);
    await expect(createRefundRequest(prisma, { transactionId: original.id, buyerId: buyer.id, amountCoupons: 1n, reason: 'too much' })).rejects.toThrow();
  });

  it('moves charity-held coupons to an applicant without minting', async () => {
    const donor = await prisma.user.create({ data: { phoneNumber: '+15550003', barcodeId: 'donor' } });
    const applicant = await prisma.user.create({ data: { phoneNumber: '+15550004', barcodeId: 'applicant' } });
    const agent = await prisma.user.create({ data: { phoneNumber: '+15550005', barcodeId: 'agent' } });
    const donorAccount = await account(AccountType.USER_COUPON, Asset.COUPON, donor.id);
    const applicantAccount = await account(AccountType.USER_COUPON, Asset.COUPON, applicant.id);
    await account(AccountType.USER_COUPON, Asset.COUPON, agent.id);
    const issuance = await account(AccountType.SYSTEM_COUPON_ISSUANCE, Asset.COUPON);
    const external = await account(AccountType.EXTERNAL_ONCHAIN, Asset.USDT);
    const vault = await account(AccountType.SYSTEM_VAULT_USDT, Asset.USDT);
    await postDeposit(prisma, { externalRef: 'deposit:charity', userId: donor.id, userCouponAccountId: donorAccount.id, externalOnchainAccountId: external.id, vaultAccountId: vault.id, issuanceAccountId: issuance.id, amountMicroUsdt: 1_000_000n });
    const charity = await prisma.charity.create({ data: { name: 'Help' } });
    const charityAccount = await account(AccountType.CHARITY_COUPON, Asset.COUPON, undefined, charity.id);
    await prisma.charityAgent.create({ data: { charityId: charity.id, userId: agent.id, role: CharityAgentRole.AGENT } });
    await donateToCharity(prisma, { memberId: donor.id, memberAccountId: donorAccount.id, charityAccountId: charityAccount.id, amountCoupons: 50n, externalRef: 'donation:charity' });
    const request = await createAidRequest(prisma, { applicantId: applicant.id, charityId: charity.id, amountCoupons: 40n, description: 'food' });
    await prisma.user.update({ where: { id: agent.id }, data: { activeGuaranteeCount: 1 } });
    const approved = await approveAidRequest(prisma, { aidRequestId: request.id, agentId: agent.id, approvedCoupons: 25n });
    expect(approved.status).toBe(AidRequestStatus.APPROVED);
    expect((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: charityAccount.id } })).balance).toBe(25n);
    expect((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: applicantAccount.id } })).balance).toBe(25n);
    await expect(approveAidRequest(prisma, { aidRequestId: request.id, agentId: agent.id })).rejects.toThrow('aid request is not pending');
  });

  it('rejects aid disbursement when charity funds are insufficient and never over-approves', async () => {
    const applicant = await prisma.user.create({ data: { phoneNumber: '+15550006', barcodeId: 'applicant-short' } });
    const agent = await prisma.user.create({ data: { phoneNumber: '+15550007', barcodeId: 'agent-short' } });
    await account(AccountType.USER_COUPON, Asset.COUPON, applicant.id);
    await account(AccountType.USER_COUPON, Asset.COUPON, agent.id);
    const charity = await prisma.charity.create({ data: { name: 'Short Help' } });
    await account(AccountType.CHARITY_COUPON, Asset.COUPON, undefined, charity.id);
    await prisma.charityAgent.create({ data: { charityId: charity.id, userId: agent.id, role: CharityAgentRole.AGENT } });
    const request = await createAidRequest(prisma, { applicantId: applicant.id, charityId: charity.id, amountCoupons: 10n, description: 'rent' });
    await expect(approveAidRequest(prisma, { aidRequestId: request.id, agentId: agent.id, approvedCoupons: 11n })).rejects.toThrow('approved amount cannot exceed requested amount');
    await expect(approveAidRequest(prisma, { aidRequestId: request.id, agentId: agent.id })).rejects.toThrow('insufficient charity balance');
    expect((await prisma.aidRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe(AidRequestStatus.PENDING);
  });

  it('allows only one concurrent pending refund request', async () => {
    const buyer = await prisma.user.create({ data: { phoneNumber: '+15550008', barcodeId: 'buyer-race' } });
    const seller = await prisma.user.create({ data: { phoneNumber: '+15550009', barcodeId: 'seller-race' } });
    const buyerAccount = await account(AccountType.USER_COUPON, Asset.COUPON, buyer.id);
    const sellerAccount = await account(AccountType.USER_COUPON, Asset.COUPON, seller.id);
    const original = await prisma.transaction.create({ data: { type: TransactionType.TRANSFER, externalRef: 'transfer:refund-race', status: 'CONFIRMED', amountCoupons: 5n } });
    await prisma.ledgerEntry.create({ data: { transactionId: original.id, fromAccountId: buyerAccount.id, toAccountId: sellerAccount.id, amount: 5n, asset: Asset.COUPON } });
    const clients = [new PrismaClient(), new PrismaClient()];
    try {
      const results = await Promise.allSettled(clients.map((client) => createRefundRequest(client, { transactionId: original.id, buyerId: buyer.id, amountCoupons: 5n, reason: 'race' })));
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(await prisma.refundRequest.count({ where: { transactionId: original.id, status: 'PENDING' } })).toBe(1);
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  });

  it('allows a restricted seller to refund but not transfer', async () => {
    const buyer = await prisma.user.create({ data: { phoneNumber: '+15550010', barcodeId: 'buyer-restricted-refund' } });
    const seller = await prisma.user.create({ data: { phoneNumber: '+15550011', barcodeId: 'seller-restricted-refund' } });
    const buyerAccount = await account(AccountType.USER_COUPON, Asset.COUPON, buyer.id);
    const sellerAccount = await account(AccountType.USER_COUPON, Asset.COUPON, seller.id);
    await prisma.ledgerAccount.update({ where: { id: buyerAccount.id }, data: { balance: 10n } });
    await prisma.ledgerAccount.update({ where: { id: sellerAccount.id }, data: { balance: 0n } });
    const original = await transferCoupons(prisma, { externalRef: 'transfer:restricted-refund', fromAccountId: buyerAccount.id, toAccountId: sellerAccount.id, amountCoupons: 10n });
    await prisma.user.update({ where: { id: seller.id }, data: { activeGuaranteeCount: 1 } });
    const refund = await createRefundRequest(prisma, { transactionId: original.id, buyerId: buyer.id, amountCoupons: 10n, reason: 'restricted seller' });
    await approveRefund(prisma, { refundRequestId: refund.id, sellerId: seller.id });
    await expect(transferCoupons(prisma, { externalRef: 'transfer:restricted-seller', fromAccountId: sellerAccount.id, toAccountId: buyerAccount.id, amountCoupons: 1n, userId: seller.id })).rejects.toThrow('account is restricted');
  });

  it('allows refunds for escrow-release purchases and only for the buyer', async () => {
    const buyer = await prisma.user.create({ data: { phoneNumber: '+15550012', barcodeId: 'buyer-escrow-refund' } });
    const seller = await prisma.user.create({ data: { phoneNumber: '+15550013', barcodeId: 'seller-escrow-refund' } });
    const unrelated = await prisma.user.create({ data: { phoneNumber: '+15550014', barcodeId: 'unrelated-escrow-refund' } });
    const buyerAccount = await account(AccountType.USER_COUPON, Asset.COUPON, buyer.id);
    const sellerAccount = await account(AccountType.USER_COUPON, Asset.COUPON, seller.id);
    const escrowAccount = await account(AccountType.ESCROW, Asset.COUPON, buyer.id);
    await prisma.ledgerAccount.update({ where: { id: buyerAccount.id }, data: { balance: 20n } });
    const hold = await createEscrowHold(prisma, {
      senderId: buyer.id,
      recipientId: seller.id,
      senderAccountId: buyerAccount.id,
      escrowAccountId: escrowAccount.id,
      amountCoupons: 10n,
      code: '1234',
      expiresAt: new Date(Date.now() + 60_000),
    });
    await releaseEscrow(prisma, { holdId: hold.id, recipientAccountId: sellerAccount.id, code: '1234' });
    const released = await prisma.transaction.findUniqueOrThrow({ where: { externalRef: `escrow:${hold.id}:release` } });
    const refund = await createRefundRequest(prisma, { transactionId: released.id, buyerId: buyer.id, amountCoupons: 10n, reason: 'escrow purchase returned' });
    await expect(createRefundRequest(prisma, { transactionId: released.id, buyerId: unrelated.id, amountCoupons: 10n, reason: 'not the buyer' })).rejects.toThrow('transaction is not refundable');
    await approveRefund(prisma, { refundRequestId: refund.id, sellerId: seller.id });
    expect((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: buyerAccount.id } })).balance).toBe(20n);
    expect((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: sellerAccount.id } })).balance).toBe(0n);
  });
});
