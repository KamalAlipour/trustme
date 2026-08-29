import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccountType, Asset, PrismaClient, GuaranteeStatus, LoanStatus } from '@trustme/db';
import {
  activateGuarantee,
  approveGuarantee,
  claimGuarantees,
  createEscrowHold,
  createLoanRequest,
  disburseLoan,
  postDeposit,
  readWithdrawalAvailability,
  repayLoan,
  requestWithdrawal,
  transferCoupons,
} from '../src/index.js';

const prisma = new PrismaClient();

async function user(barcodeId: string, isDemo = false) {
  const created = await prisma.user.create({ data: { phoneNumber: `+1555${barcodeId}`, barcodeId, isDemo, identityVerificationStatus: 'VERIFIED', identityVerifiedAt: new Date() } });
  const account = await prisma.ledgerAccount.create({ data: { userId: created.id, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
  const escrowAccount = await prisma.ledgerAccount.create({ data: { userId: created.id, type: AccountType.ESCROW, asset: Asset.COUPON } });
  return { ...created, account, escrowAccount };
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
  const escrow = await system(AccountType.ESCROW, Asset.COUPON);
  const fees = await system(AccountType.SYSTEM_FEE_COLLECTION, Asset.USDT);
  const pending = await system(AccountType.SYSTEM_WITHDRAWAL_PENDING, Asset.USDT);
  const borrower = await user('borrower');
  const lender = await user('lender');
  const guarantorA = await user('guarantora');
  const guarantorB = await user('guarantorb');
  for (const member of [borrower, lender, guarantorA, guarantorB]) await fund(member, external, vault, issuance, 10_000n);
  return { external, vault, issuance, lock, escrow, fees, pending, borrower, lender, guarantorA, guarantorB };
}

async function couponCollateralTotal() {
  const accounts = await prisma.ledgerAccount.findMany({
    where: { asset: Asset.COUPON, type: { in: [AccountType.USER_COUPON, AccountType.GUARANTEE_LOCK] } },
    select: { balance: true },
  });
  return accounts.reduce((sum, account) => sum + account.balance, 0n);
}

function withdrawalInput(fixture: Awaited<ReturnType<typeof setup>>, member: Awaited<ReturnType<typeof user>>) {
  return {
    userId: member.id,
    userAccountId: member.account.id,
    destinationAddress: '0x52908400098527886E0F7030069857D2E4169EE7',
    couponsGross: 1n,
    baseFeeBps: 100n,
    minimumFeeMicroUsdt: 0n,
    minimumWithdrawalMicroUsdt: 1n,
    autoApprovalLimitMicroUsdt: 1_000_000_000n,
    vaultAccountId: fixture.vault.id,
    feeAccountId: fixture.fees.id,
    pendingAccountId: fixture.pending.id,
    issuanceAccountId: fixture.issuance.id,
    cooldownHours: 168,
    requireIdentityVerification: true,
  };
}

beforeAll(async () => prisma.$connect());
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "MediaAsset", "RefundRequest", "AidRequest", "CharityAgent", "Charity", "AdminAuditLog", "AdminUser", "Withdrawal", "EscrowHold", "EmailVerification", "MemberDevice", "Contact", "LoanInstallment", "Guarantee", "Loan", "LedgerEntry", "Transaction", "LedgerAccount", "DepositAddress", "User", "ChainCursor", "SystemSetting" CASCADE');
});
afterAll(async () => prisma.$disconnect());

describe('lending domain', () => {
  it('rejects mixed demo and real transfers, escrows, loans, and withdrawals', async () => {
    const fixture = await setup();
    const demo = await user('demo', true);
    await expect(transferCoupons(prisma, {
      userId: fixture.borrower.id,
      counterpartyUserId: demo.id,
      fromAccountId: fixture.borrower.account.id,
      toAccountId: demo.account.id,
      amountCoupons: 1n,
      externalRef: 'mixed:transfer',
    })).rejects.toThrow('demo and real accounts cannot exchange coupons');
    await expect(createEscrowHold(prisma, {
      senderId: fixture.borrower.id,
      recipientId: demo.id,
      senderAccountId: fixture.borrower.account.id,
      escrowAccountId: demo.escrowAccount.id,
      amountCoupons: 1n,
      code: '1234',
      expiresAt: new Date(Date.now() + 60_000),
    })).rejects.toThrow('demo and real accounts cannot exchange coupons');
    await expect(createLoanRequest(prisma, {
      borrowerId: fixture.borrower.id,
      principalCoupons: 1n,
      installments: [{ amountCoupons: 1n, dueAt: new Date(Date.now() + 86_400_000) }],
      guarantors: [{ guarantorId: demo.id, amountCoupons: 1n }],
    })).rejects.toThrow('demo and real accounts cannot exchange coupons');
    await expect(requestWithdrawal(prisma, withdrawalInput(fixture, demo))).rejects.toThrow('demo accounts cannot withdraw');
  });

  it('allocates repayments and releases all guarantees on settlement', async () => {
    const fixture = await setup();
    const initialCouponCollateral = await couponCollateralTotal();
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
    await expect(repayLoan(prisma, { loanId: loan.id, amountCoupons: 351n, borrowerAccountId: fixture.borrower.account.id, lenderAccountId: fixture.lender.account.id, externalRef: 'repay:too-much' })).rejects.toThrow('repayment exceeds outstanding debt');
    await repayLoan(prisma, { loanId: loan.id, amountCoupons: 350n, borrowerAccountId: fixture.borrower.account.id, lenderAccountId: fixture.lender.account.id, externalRef: 'repay:2' });
    const settled = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } });
    expect(settled.status).toBe(LoanStatus.SETTLED);
    expect(await prisma.guarantee.count({ where: { loanId: loan.id, status: GuaranteeStatus.RELEASED } })).toBe(2);
    installments = await prisma.loanInstallment.findMany({ where: { loanId: loan.id } });
    expect(installments.every((item) => item.paidAt !== null)).toBe(true);
    expect(await couponCollateralTotal()).toBe(initialCouponCollateral);
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
    await expect(claimGuarantees(prisma, { loanId: loan.id, lenderAccountId: fixture.lender.account.id })).rejects.toThrow('loan has no overdue installment');
    await prisma.loanInstallment.updateMany({ where: { loanId: loan.id }, data: { dueAt: new Date(Date.now() - 1_000) } });
    await claimGuarantees(prisma, { loanId: loan.id, lenderAccountId: fixture.lender.account.id });
    const orderedGuarantees = await prisma.guarantee.findMany({ where: { loanId: loan.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const firstClaim = orderedGuarantees[0]!.amountCoupons * 2n / 3n + 1n;
    const secondClaim = orderedGuarantees[1]!.amountCoupons * 2n / 3n;
    const claims = await prisma.transaction.findMany({ where: { externalRef: { endsWith: ':claim' } } });
    expect(claims).toHaveLength(Number(firstClaim > 0n) + Number(secondClaim > 0n));
    expect(claims.reduce((sum, claim) => sum + claim.amountCoupons, 0n)).toBe(2n);
    for (const [index, expected] of [firstClaim, secondClaim].entries()) {
      const claim = await prisma.transaction.findUnique({ where: { externalRef: `guarantee:${orderedGuarantees[index]!.id}:claim` } });
      if (expected > 0n) expect(claim?.amountCoupons).toBe(expected);
      else expect(claim).toBeNull();
    }
    expect(await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).toMatchObject({ status: LoanStatus.DEFAULTED, outstandingCoupons: 0n });
  });

  it('repays residual debt after a partial default claim', async () => {
    const fixture = await setup();
    const loan = await createLoanRequest(prisma, {
      borrowerId: fixture.borrower.id,
      principalCoupons: 5n,
      installments: [{ amountCoupons: 5n, dueAt: new Date(Date.now() + 86_400_000) }],
      guarantors: [{ guarantorId: fixture.guarantorA.id, amountCoupons: 1n }],
    });
    const guarantee = loan.guarantees[0]!;
    await prisma.loanInstallment.updateMany({ where: { loanId: loan.id }, data: { dueAt: new Date(Date.now() - 1_000) } });
    await approveGuarantee(prisma, { guaranteeId: guarantee.id, code: '1234', guarantorAccountId: fixture.guarantorA.account.id, guaranteeLockAccountId: fixture.lock.id });
    await activateGuarantee(prisma, { guaranteeId: guarantee.id, code: '1234' });
    await disburseLoan(prisma, { loanId: loan.id, lenderId: fixture.lender.id, lenderAccountId: fixture.lender.account.id, borrowerAccountId: fixture.borrower.account.id });
    await claimGuarantees(prisma, { loanId: loan.id, lenderAccountId: fixture.lender.account.id });
    await expect(readWithdrawalAvailability(prisma, fixture.borrower.id)).resolves.toMatchObject({
      blockers: ['unresolved_claim'],
      outstandingDebtCoupons: 4n,
    });
    await repayLoan(prisma, {
      loanId: loan.id,
      amountCoupons: 4n,
      borrowerAccountId: fixture.borrower.account.id,
      lenderAccountId: fixture.lender.account.id,
      externalRef: 'repay:defaulted-residual',
    });
    await expect(prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).resolves.toMatchObject({
      status: LoanStatus.SETTLED,
      outstandingCoupons: 0n,
    });
  });

  it('blocks new loans and guarantees while restricted but allows repayment', async () => {
    const fixture = await setup();
    const firstLoan = await createLoanRequest(prisma, {
      borrowerId: fixture.guarantorA.id,
      principalCoupons: 2n,
      installments: [{ amountCoupons: 2n, dueAt: new Date(Date.now() + 86_400_000) }],
      guarantors: [{ guarantorId: fixture.guarantorB.id, amountCoupons: 1n }],
    });
    const secondLoan = await createLoanRequest(prisma, {
      borrowerId: fixture.guarantorB.id,
      principalCoupons: 2n,
      installments: [{ amountCoupons: 2n, dueAt: new Date(Date.now() + 86_400_000) }],
      guarantors: [{ guarantorId: fixture.guarantorA.id, amountCoupons: 1n }],
    });
    const thirdLoan = await createLoanRequest(prisma, {
      borrowerId: fixture.borrower.id,
      principalCoupons: 2n,
      installments: [{ amountCoupons: 2n, dueAt: new Date(Date.now() + 86_400_000) }],
      guarantors: [{ guarantorId: fixture.guarantorA.id, amountCoupons: 1n }],
    });
    const firstGuarantee = firstLoan.guarantees[0]!;
    const secondGuarantee = secondLoan.guarantees[0]!;
    const thirdGuarantee = thirdLoan.guarantees[0]!;
    await approveGuarantee(prisma, {
      guaranteeId: secondGuarantee.id,
      code: '1234',
      guarantorAccountId: fixture.guarantorA.account.id,
      guaranteeLockAccountId: fixture.lock.id,
    });
    await expect(createLoanRequest(prisma, {
      borrowerId: fixture.guarantorA.id,
      principalCoupons: 1n,
      installments: [{ amountCoupons: 1n, dueAt: new Date(Date.now() + 86_400_000) }],
      guarantors: [{ guarantorId: fixture.guarantorB.id, amountCoupons: 1n }],
    })).rejects.toThrow('account is restricted');
    await expect(approveGuarantee(prisma, {
      guaranteeId: thirdGuarantee.id,
      code: '1234',
      guarantorAccountId: fixture.guarantorA.account.id,
      guaranteeLockAccountId: fixture.lock.id,
    })).rejects.toThrow('account is restricted');
    await approveGuarantee(prisma, {
      guaranteeId: firstGuarantee.id,
      code: '1234',
      guarantorAccountId: fixture.guarantorB.account.id,
      guaranteeLockAccountId: fixture.lock.id,
    });
    await activateGuarantee(prisma, { guaranteeId: firstGuarantee.id, code: '1234' });
    await disburseLoan(prisma, {
      loanId: firstLoan.id,
      lenderId: fixture.lender.id,
      lenderAccountId: fixture.lender.account.id,
      borrowerAccountId: fixture.guarantorA.account.id,
    });
    await expect(repayLoan(prisma, {
      loanId: firstLoan.id,
      amountCoupons: 2n,
      borrowerAccountId: fixture.guarantorA.account.id,
      lenderAccountId: fixture.lender.account.id,
      externalRef: 'repay:restricted-borrower',
    })).resolves.toMatchObject({ status: LoanStatus.SETTLED });
  });

  it('rejects withdrawals independently for pending codes and unresolved claims', async () => {
    const fixture = await setup();
    await createEscrowHold(prisma, {
      senderId: fixture.guarantorA.id,
      recipientId: fixture.borrower.id,
      senderAccountId: fixture.guarantorA.account.id,
      escrowAccountId: fixture.escrow.id,
      amountCoupons: 1n,
      code: '1234',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await expect(requestWithdrawal(prisma, withdrawalInput(fixture, fixture.guarantorA))).rejects.toThrow('withdrawal blocked by pending code');

    const loan = await createLoanRequest(prisma, {
      borrowerId: fixture.borrower.id,
      principalCoupons: 5n,
      installments: [{ amountCoupons: 5n, dueAt: new Date(Date.now() + 86_400_000) }],
      guarantors: [{ guarantorId: fixture.guarantorB.id, amountCoupons: 1n }],
    });
    const guarantee = loan.guarantees[0]!;
    await prisma.loanInstallment.updateMany({ where: { loanId: loan.id }, data: { dueAt: new Date(Date.now() - 1_000) } });
    await approveGuarantee(prisma, {
      guaranteeId: guarantee.id,
      code: '1234',
      guarantorAccountId: fixture.guarantorB.account.id,
      guaranteeLockAccountId: fixture.lock.id,
    });
    await activateGuarantee(prisma, { guaranteeId: guarantee.id, code: '1234' });
    await disburseLoan(prisma, {
      loanId: loan.id,
      lenderId: fixture.lender.id,
      lenderAccountId: fixture.lender.account.id,
      borrowerAccountId: fixture.borrower.account.id,
    });
    await claimGuarantees(prisma, { loanId: loan.id, lenderAccountId: fixture.lender.account.id });
    await expect(requestWithdrawal(prisma, withdrawalInput(fixture, fixture.borrower))).rejects.toThrow('withdrawal blocked by unresolved claim');
  });

  it('persists the configured withdrawal cooldown exactly', async () => {
    const fixture = await setup();
    const requestedAt = Date.now();
    const withdrawal = await requestWithdrawal(prisma, withdrawalInput(fixture, fixture.borrower));
    const expected = requestedAt + 168 * 60 * 60 * 1000;
    expect(withdrawal.eligibleAt.getTime()).toBeGreaterThanOrEqual(expected);
    expect(withdrawal.eligibleAt.getTime()).toBeLessThanOrEqual(Date.now() + 168 * 60 * 60 * 1000);
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

  it('gates withdrawals on identity when enabled and permits them when disabled', async () => {
    const fixture = await setup();
    await prisma.user.update({
      where: { id: fixture.borrower.id },
      data: { identityVerificationStatus: 'UNVERIFIED', identityVerifiedAt: null },
    });
    await expect(readWithdrawalAvailability(prisma, fixture.borrower.id)).resolves.toMatchObject({
      blockers: ['identity_unverified'],
    });
    await expect(readWithdrawalAvailability(prisma, fixture.borrower.id, { requireIdentityVerification: false })).resolves.toMatchObject({
      blockers: [],
    });
    await expect(requestWithdrawal(prisma, withdrawalInput(fixture, fixture.borrower))).rejects.toThrow('withdrawal blocked by identity verification');
    await expect(requestWithdrawal(prisma, { ...withdrawalInput(fixture, fixture.borrower), requireIdentityVerification: false })).resolves.toBeDefined();
  });
});
