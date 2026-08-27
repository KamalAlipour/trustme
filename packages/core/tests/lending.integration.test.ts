import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccountType, Asset, PrismaClient, GuaranteeStatus, LoanStatus } from '@trustme/db';
import {
  activateGuarantee,
  approveGuarantee,
  claimGuarantees,
  createLoanRequest,
  disburseLoan,
  postDeposit,
  readWithdrawalAvailability,
  repayLoan,
  transferCoupons,
} from '../src/index.js';

const prisma = new PrismaClient();

async function user(barcodeId: string) {
  const created = await prisma.user.create({ data: { phoneNumber: `+1555${barcodeId}`, barcodeId } });
  const account = await prisma.ledgerAccount.create({ data: { userId: created.id, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
  return { ...created, account };
}

async function system(type: AccountType, asset: Asset) {
  return prisma.ledgerAccount.create({ data: { type, asset } });
}

async function fund(member: Awaited<ReturnType<typeof user>>, external: { id: string }, vault: { id: string }, issuance: { id: string }, amount: bigint) {
  await postDeposit(prisma, {
    externalRef: `fund:${member.id}:${amount}:${Math.random()}`,
    userId: member.id,
    userCouponAccountId: member.account.id,
    externalOnchainAccountId: external.id,
    vaultAccountId: vault.id,
    issuanceAccountId: issuance.id,
    amountMicroUsdt: amount * 10_000n,
  });
}

async function setup() {
  const external = await system(AccountType.EXTERNAL_ONCHAIN, Asset.USDT);
  const vault = await system(AccountType.SYSTEM_VAULT_USDT, Asset.USDT);
  const issuance = await system(AccountType.SYSTEM_COUPON_ISSUANCE, Asset.COUPON);
  const lock = await system(AccountType.GUARANTEE_LOCK, Asset.COUPON);
  const borrower = await user('borrower');
  const lender = await user('lender');
  const guarantorA = await user('guarantora');
  const guarantorB = await user('guarantorb');
  for (const member of [borrower, lender, guarantorA, guarantorB]) await fund(member, external, vault, issuance, 10_000n);
  return { external, vault, issuance, lock, borrower, lender, guarantorA, guarantorB };
}

beforeAll(async () => prisma.$connect());
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "AdminAuditLog", "AdminUser", "Withdrawal", "EscrowHold", "LoanInstallment", "Guarantee", "Loan", "LedgerEntry", "Transaction", "LedgerAccount", "DepositAddress", "User", "ChainCursor", "SystemSetting" CASCADE');
});
afterAll(async () => prisma.$disconnect());

describe('lending domain', () => {
  it('allocates repayments and releases all guarantees on settlement', async () => {
    const fixture = await setup();
    const loan = await createLoanRequest(prisma, {
      borrowerId: fixture.borrower.id,
      principalCoupons: 600n,
      installments: [
        { amountCoupons: 200n, dueAt: new Date(Date.now() + 86_400_000) },
        { amountCoupons: 400n, dueAt: new Date(Date.now() + 172_800_000) },
      ],
      guarantors: [
        { guarantorId: fixture.guarantorA.id, amountCoupons: 300n },
        { guarantorId: fixture.guarantorB.id, amountCoupons: 200n },
      ],
    });
    for (const guarantee of loan.guarantees) {
      await approveGuarantee(prisma, { guaranteeId: guarantee.id, code: '1234', guarantorAccountId: guarantee.guarantorId === fixture.guarantorA.id ? fixture.guarantorA.account.id : fixture.guarantorB.account.id, guaranteeLockAccountId: fixture.lock.id });
      await activateGuarantee(prisma, { guaranteeId: guarantee.id, code: '1234' });
    }
    await disburseLoan(prisma, { loanId: loan.id, lenderId: fixture.lender.id, lenderAccountId: fixture.lender.account.id, borrowerAccountId: fixture.borrower.account.id });
    await expect(readWithdrawalAvailability(prisma, fixture.borrower.id)).resolves.toMatchObject({
      balanceCoupons: 10_600n,
      outstandingDebtCoupons: 600n,
      totalCollateralCoupons: 10_600n,
      availableToWithdrawCoupons: 10_000n,
    });
    await repayLoan(prisma, { loanId: loan.id, amountCoupons: 250n, borrowerAccountId: fixture.borrower.account.id, lenderAccountId: fixture.lender.account.id, externalRef: 'repay:1' });
    let installments = await prisma.loanInstallment.findMany({ where: { loanId: loan.id }, orderBy: { sequence: 'asc' } });
    expect(installments.map((item) => item.paidCoupons)).toEqual([200n, 50n]);
    await repayLoan(prisma, { loanId: loan.id, amountCoupons: 350n, borrowerAccountId: fixture.borrower.account.id, lenderAccountId: fixture.lender.account.id, externalRef: 'repay:2' });
    const settled = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } });
    expect(settled.status).toBe(LoanStatus.SETTLED);
    expect(await prisma.guarantee.count({ where: { loanId: loan.id, status: GuaranteeStatus.RELEASED } })).toBe(2);
    installments = await prisma.loanInstallment.findMany({ where: { loanId: loan.id } });
    expect(installments.every((item) => item.paidAt !== null)).toBe(true);
  });

  it('claims a deterministic pro-rata remainder and enforces restriction', async () => {
    const fixture = await setup();
    const loan = await createLoanRequest(prisma, {
      borrowerId: fixture.borrower.id,
      principalCoupons: 2n,
      installments: [{ amountCoupons: 2n, dueAt: new Date(Date.now() + 86_400_000) }],
      guarantors: [
        { guarantorId: fixture.guarantorA.id, amountCoupons: 2n },
        { guarantorId: fixture.guarantorB.id, amountCoupons: 1n },
      ],
    });
    for (const guarantee of loan.guarantees) {
      const account = guarantee.guarantorId === fixture.guarantorA.id ? fixture.guarantorA.account : fixture.guarantorB.account;
      await approveGuarantee(prisma, { guaranteeId: guarantee.id, code: '1234', guarantorAccountId: account.id, guaranteeLockAccountId: fixture.lock.id });
      await activateGuarantee(prisma, { guaranteeId: guarantee.id, code: '1234' });
    }
    await expect(transferCoupons(prisma, { userId: fixture.guarantorA.id, externalRef: 'restricted-transfer', fromAccountId: fixture.guarantorA.account.id, toAccountId: fixture.borrower.account.id, amountCoupons: 1n })).rejects.toThrow('account is restricted');
    await disburseLoan(prisma, { loanId: loan.id, lenderId: fixture.lender.id, lenderAccountId: fixture.lender.account.id, borrowerAccountId: fixture.borrower.account.id });
    await claimGuarantees(prisma, { loanId: loan.id, lenderAccountId: fixture.lender.account.id });
    const orderedGuarantees = await prisma.guarantee.findMany({ where: { loanId: loan.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const firstClaim = orderedGuarantees[0]!.amountCoupons * 2n / 3n + 1n;
    const secondClaim = orderedGuarantees[1]!.amountCoupons * 2n / 3n;
    const claims = await prisma.transaction.findMany({ where: { externalRef: { endsWith: ':claim' } } });
    expect(claims).toHaveLength(Number(firstClaim > 0n) + Number(secondClaim > 0n));
    for (const [index, expected] of [firstClaim, secondClaim].entries()) {
      const claim = await prisma.transaction.findUnique({ where: { externalRef: `guarantee:${orderedGuarantees[index]!.id}:claim` } });
      if (expected > 0n) expect(claim?.amountCoupons).toBe(expected);
      else expect(claim).toBeNull();
    }
    expect(await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).toMatchObject({ status: LoanStatus.DEFAULTED, outstandingCoupons: 0n });
  });

  it('locks a guarantee after five wrong activation codes and exposes collateral without double subtraction', async () => {
    const fixture = await setup();
    const loan = await createLoanRequest(prisma, {
      borrowerId: fixture.borrower.id,
      principalCoupons: 100n,
      installments: [{ amountCoupons: 100n, dueAt: new Date(Date.now() + 86_400_000) }],
      guarantors: [{ guarantorId: fixture.guarantorA.id, amountCoupons: 300n }],
    });
    const guarantee = loan.guarantees[0];
    await approveGuarantee(prisma, {
      guaranteeId: guarantee.id,
      code: '1234',
      guarantorAccountId: fixture.guarantorA.account.id,
      guaranteeLockAccountId: fixture.lock.id,
    });
    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(activateGuarantee(prisma, { guaranteeId: guarantee.id, code: '9999' })).rejects.toThrow('invalid guarantee code');
    }
    await expect(activateGuarantee(prisma, { guaranteeId: guarantee.id, code: '9999' })).rejects.toThrow('guarantee code locked');
    const locked = await prisma.guarantee.findUniqueOrThrow({ where: { id: guarantee.id }, select: { status: true, wrongAttempts: true } });
    expect(locked).toMatchObject({ status: GuaranteeStatus.CODE_LOCKED, wrongAttempts: 5 });
    await expect(activateGuarantee(prisma, { guaranteeId: guarantee.id, code: '1234' })).rejects.toThrow('guarantee code is locked');
    const availability = await readWithdrawalAvailability(prisma, fixture.guarantorA.id);
    expect(availability).toMatchObject({
      balanceCoupons: 9_700n,
      lockedGuaranteeCoupons: 300n,
      totalCollateralCoupons: 10_000n,
      availableToWithdrawCoupons: 9_700n,
      blockers: ['restricted', 'pending_code'],
    });
  });
});
