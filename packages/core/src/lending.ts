import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import {
  AccountType,
  Asset,
  GuaranteeStatus,
  LoanStatus,
  Prisma,
  PrismaClient,
  TransactionStatus,
  TransactionType,
} from '@trustme/db';
import { postWithClient } from './ledger.js';
import { DomainError } from './domain-error.js';
import { fourDigitCodeSchema } from './schemas.js';
import { withSerializableRetry } from './retry.js';
import { assertSameDemoSide } from './demo.js';

const lockedGuaranteeStatuses = [GuaranteeStatus.CONFIRMATION_PENDING, GuaranteeStatus.CODE_LOCKED, GuaranteeStatus.ACTIVE];

export type LoanInstallmentInput = { dueAt: Date; amountCoupons: bigint };
export type LoanGuarantorInput = { guarantorId: string; amountCoupons: bigint };

export type WithdrawalBlocker = 'restricted' | 'pending_code' | 'unresolved_claim' | 'pin_reset_quarantine';
export type WithdrawalAvailability = {
  balanceCoupons: bigint;
  lockedGuaranteeCoupons: bigint;
  outstandingDebtCoupons: bigint;
  totalCollateralCoupons: bigint;
  availableToWithdrawCoupons: bigint;
  blockers: WithdrawalBlocker[];
};

export async function assertNotRestricted(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${userId}::uuid FOR UPDATE`);
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { activeGuaranteeCount: true } });
  if (user.activeGuaranteeCount > 0) throw new DomainError('account is restricted by an active guarantee');
}

export async function assertNoPinResetQuarantine(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${userId}::uuid FOR UPDATE`);
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { pinResetQuarantineUntil: true } });
  if (user.pinResetQuarantineUntil !== null && user.pinResetQuarantineUntil > new Date()) {
    throw new DomainError('account is quarantined after a PIN reset');
  }
}

async function lockUser(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${userId}::uuid FOR UPDATE`);
  return tx.user.findUniqueOrThrow({ where: { id: userId } });
}

async function userCouponAccount(tx: Prisma.TransactionClient, userId: string) {
  return tx.ledgerAccount.findFirstOrThrow({ where: { userId, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
}

async function requireUserCouponAccount(tx: Prisma.TransactionClient, accountId: string, userId: string) {
  const account = await tx.ledgerAccount.findUniqueOrThrow({ where: { id: accountId } });
  if (account.userId !== userId || account.type !== AccountType.USER_COUPON || account.asset !== Asset.COUPON) {
    throw new DomainError('invalid user coupon account');
  }
  return account;
}

async function guaranteeLockAccount(tx: Prisma.TransactionClient, accountId?: string) {
  const account = accountId === undefined
    ? await tx.ledgerAccount.findFirstOrThrow({ where: { type: AccountType.GUARANTEE_LOCK, asset: Asset.COUPON, userId: null } })
    : await tx.ledgerAccount.findUniqueOrThrow({ where: { id: accountId } });
  if (account.type !== AccountType.GUARANTEE_LOCK || account.asset !== Asset.COUPON || account.userId !== null) {
    throw new DomainError('invalid guarantee lock account');
  }
  return account;
}

async function readAvailability(tx: Prisma.TransactionClient | PrismaClient, userId: string): Promise<WithdrawalAvailability> {
  const account = await tx.ledgerAccount.findFirstOrThrow({ where: { userId, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
  const locked = await tx.guarantee.aggregate({
    where: { guarantorId: userId, status: { in: lockedGuaranteeStatuses } },
    _sum: { amountCoupons: true },
  });
  const debt = await tx.loan.aggregate({
    where: { borrowerId: userId, status: { in: [LoanStatus.ACTIVE, LoanStatus.DEFAULTED] }, outstandingCoupons: { gt: 0n } },
    _sum: { outstandingCoupons: true },
  });
  const [pendingEscrow, pendingGuarantee, unresolvedClaim, user] = await Promise.all([
    tx.escrowHold.count({ where: { senderId: userId, status: { in: ['ACTIVE', 'LOCKED'] } } }),
    tx.guarantee.count({ where: { guarantorId: userId, status: { in: [GuaranteeStatus.CONFIRMATION_PENDING, GuaranteeStatus.CODE_LOCKED] } } }),
    tx.loan.count({ where: { borrowerId: userId, status: LoanStatus.DEFAULTED, outstandingCoupons: { gt: 0n } } }),
    tx.user.findUniqueOrThrow({ where: { id: userId }, select: { activeGuaranteeCount: true, pinResetQuarantineUntil: true } }),
  ]);
  const blockers: WithdrawalBlocker[] = [];
  if (user.activeGuaranteeCount > 0) blockers.push('restricted');
  if (pendingEscrow > 0 || pendingGuarantee > 0) blockers.push('pending_code');
  if (unresolvedClaim > 0) blockers.push('unresolved_claim');
  if (user.pinResetQuarantineUntil !== null && user.pinResetQuarantineUntil > new Date()) blockers.push('pin_reset_quarantine');
  const balanceCoupons = account.balance;
  const lockedGuaranteeCoupons = locked._sum.amountCoupons ?? 0n;
  const outstandingDebtCoupons = debt._sum.outstandingCoupons ?? 0n;
  const totalCollateralCoupons = balanceCoupons + lockedGuaranteeCoupons;
  const availableToWithdrawCoupons = totalCollateralCoupons - lockedGuaranteeCoupons - outstandingDebtCoupons > 0n
    ? totalCollateralCoupons - lockedGuaranteeCoupons - outstandingDebtCoupons
    : 0n;
  return {
    balanceCoupons,
    lockedGuaranteeCoupons,
    outstandingDebtCoupons,
    totalCollateralCoupons,
    availableToWithdrawCoupons,
    blockers,
  };
}

export function readWithdrawalAvailability(prisma: PrismaClient, userId: string): Promise<WithdrawalAvailability> {
  return readAvailability(prisma, userId);
}

export function readWithdrawalAvailabilityInTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<WithdrawalAvailability> {
  return readAvailability(tx, userId);
}

export async function createLoanRequest(
  prisma: PrismaClient,
  input: {
    borrowerId: string;
    principalCoupons: bigint;
    installments: readonly LoanInstallmentInput[];
    guarantors: readonly LoanGuarantorInput[];
  },
) {
  if (input.principalCoupons <= 0n) throw new DomainError('loan principal must be positive');
  if (input.installments.length === 0) throw new DomainError('loan requires at least one installment');
  if (input.guarantors.length === 0) throw new DomainError('loan requires at least one guarantor');
  const now = new Date();
  let installmentTotal = 0n;
  let previousDueAt = now;
  for (const installment of input.installments) {
    if (installment.amountCoupons <= 0n) throw new DomainError('installment amount must be positive');
    if (installment.dueAt <= now || installment.dueAt <= previousDueAt) throw new DomainError('installment due dates must be strictly increasing and in the future');
    installmentTotal += installment.amountCoupons;
    previousDueAt = installment.dueAt;
  }
  if (installmentTotal !== input.principalCoupons) throw new DomainError('installments must sum to the loan principal');
  const guarantorIds = input.guarantors.map((guarantor) => guarantor.guarantorId);
  if (new Set(guarantorIds).size !== guarantorIds.length) throw new DomainError('loan guarantors must be unique');
  for (const guarantor of input.guarantors) {
    if (guarantor.amountCoupons <= 0n) throw new DomainError('guarantee amount must be positive');
    if (guarantor.guarantorId === input.borrowerId) throw new DomainError('borrower cannot guarantee their own loan');
  }
  const loanId = randomUUID();
  return withSerializableRetry(prisma, async (tx) => {
    await assertNotRestricted(tx, input.borrowerId);
    await assertNoPinResetQuarantine(tx, input.borrowerId);
    for (const guarantorId of [...guarantorIds].sort()) {
      await assertSameDemoSide(tx, input.borrowerId, guarantorId);
      await assertNotRestricted(tx, guarantorId);
      await assertNoPinResetQuarantine(tx, guarantorId);
    }
    const loan = await tx.loan.create({
      data: {
        id: loanId,
        borrowerId: input.borrowerId,
        principalCoupons: input.principalCoupons,
        installments: {
          create: input.installments.map((installment, index) => ({
            sequence: index + 1,
            dueAt: installment.dueAt,
            amountCoupons: installment.amountCoupons,
          })),
        },
        guarantees: {
          create: input.guarantors.map((guarantor) => ({
            guarantorId: guarantor.guarantorId,
            amountCoupons: guarantor.amountCoupons,
          })),
        },
      },
      include: { installments: true, guarantees: true },
    });
    return loan;
  });
}

export async function approveGuarantee(
  prisma: PrismaClient,
  input: { guaranteeId: string; code: string; guarantorAccountId: string; guaranteeLockAccountId?: string },
) {
  fourDigitCodeSchema.parse(input.code);
  const codeHash = await bcrypt.hash(input.code, 10);
  return withSerializableRetry(prisma, async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Guarantee" WHERE "id" = ${input.guaranteeId}::uuid FOR UPDATE`);
    const guarantee = await tx.guarantee.findUniqueOrThrow({ where: { id: input.guaranteeId } });
    if (guarantee.status !== GuaranteeStatus.PENDING) throw new DomainError('guarantee is not pending');
    const loan = await tx.loan.findUniqueOrThrow({ where: { id: guarantee.loanId } });
    if (loan.status !== LoanStatus.REQUESTED) throw new DomainError('loan is not awaiting guarantees');
    await assertSameDemoSide(tx, loan.borrowerId, guarantee.guarantorId);
    await assertNotRestricted(tx, guarantee.guarantorId);
    await assertNoPinResetQuarantine(tx, guarantee.guarantorId);
    await requireUserCouponAccount(tx, input.guarantorAccountId, guarantee.guarantorId);
    const lockAccount = await guaranteeLockAccount(tx, input.guaranteeLockAccountId);
    const transaction = await postWithClient(tx, {
      type: TransactionType.GUARANTEE_LOCK,
      externalRef: `guarantee:${guarantee.id}:lock`,
      userId: guarantee.guarantorId,
      status: TransactionStatus.CONFIRMED,
      amountCoupons: guarantee.amountCoupons,
      legs: [{ fromAccountId: input.guarantorAccountId, toAccountId: lockAccount.id, amount: guarantee.amountCoupons, asset: Asset.COUPON }],
    });
    await lockUser(tx, guarantee.guarantorId);
    await tx.user.update({ where: { id: guarantee.guarantorId }, data: { activeGuaranteeCount: { increment: 1 } } });
    return tx.guarantee.update({
      where: { id: guarantee.id },
      data: { codeHash, lockTransactionId: transaction.id, status: GuaranteeStatus.CONFIRMATION_PENDING, lockedAt: new Date() },
    });
  });
}

export async function activateGuarantee(prisma: PrismaClient, input: { guaranteeId: string; code: string }) {
  fourDigitCodeSchema.parse(input.code);
  const result = await withSerializableRetry(prisma, async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Guarantee" WHERE "id" = ${input.guaranteeId}::uuid FOR UPDATE`);
    const guarantee = await tx.guarantee.findUniqueOrThrow({ where: { id: input.guaranteeId } });
    if (guarantee.status === GuaranteeStatus.CODE_LOCKED || guarantee.wrongAttempts >= 5) throw new DomainError('guarantee code is locked');
    if (guarantee.status !== GuaranteeStatus.CONFIRMATION_PENDING) throw new DomainError('guarantee is not awaiting code confirmation');
    const valid = guarantee.codeHash !== null && await bcrypt.compare(input.code, guarantee.codeHash);
    if (!valid) {
      const wrongAttempts = guarantee.wrongAttempts + 1;
      await tx.guarantee.update({
        where: { id: guarantee.id },
        data: { wrongAttempts, status: wrongAttempts >= 5 ? GuaranteeStatus.CODE_LOCKED : GuaranteeStatus.CONFIRMATION_PENDING },
      });
      return { guarantee: null, error: wrongAttempts >= 5 ? 'guarantee code locked' : 'invalid guarantee code' };
    }
    return {
      guarantee: await tx.guarantee.update({ where: { id: guarantee.id }, data: { status: GuaranteeStatus.ACTIVE, activatedAt: new Date() } }),
      error: null,
    };
  });
  if (result.error) throw new DomainError(result.error);
  return result.guarantee;
}

export async function cancelGuarantee(
  prisma: PrismaClient,
  input: { guaranteeId: string; guarantorAccountId: string; guaranteeLockAccountId?: string; declined?: boolean },
) {
  return withSerializableRetry(prisma, async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Guarantee" WHERE "id" = ${input.guaranteeId}::uuid FOR UPDATE`);
    const guarantee = await tx.guarantee.findUniqueOrThrow({ where: { id: input.guaranteeId } });
    const cancellableStatuses: GuaranteeStatus[] = [GuaranteeStatus.PENDING, GuaranteeStatus.CONFIRMATION_PENDING, GuaranteeStatus.CODE_LOCKED];
    if (!cancellableStatuses.includes(guarantee.status)) {
      throw new DomainError('guarantee cannot be cancelled in its current state');
    }
    const loan = await tx.loan.findUniqueOrThrow({ where: { id: guarantee.loanId } });
    await assertSameDemoSide(tx, loan.borrowerId, guarantee.guarantorId);
    if (loan.status === LoanStatus.ACTIVE) throw new DomainError('guarantee cannot be cancelled after loan disbursement');
    if (guarantee.status !== GuaranteeStatus.PENDING) {
      const lockAccount = await guaranteeLockAccount(tx, input.guaranteeLockAccountId);
      await requireUserCouponAccount(tx, input.guarantorAccountId, guarantee.guarantorId);
      await postWithClient(tx, {
        type: TransactionType.GUARANTEE_RELEASE,
        externalRef: `guarantee:${guarantee.id}:release`,
        userId: guarantee.guarantorId,
        status: TransactionStatus.CONFIRMED,
        amountCoupons: guarantee.amountCoupons,
        legs: [{ fromAccountId: lockAccount.id, toAccountId: input.guarantorAccountId, amount: guarantee.amountCoupons, asset: Asset.COUPON }],
      });
      await lockUser(tx, guarantee.guarantorId);
      await tx.user.update({ where: { id: guarantee.guarantorId }, data: { activeGuaranteeCount: { decrement: 1 } } });
    }
    return tx.guarantee.update({
      where: { id: guarantee.id },
      data: { status: input.declined ? GuaranteeStatus.DECLINED : GuaranteeStatus.CANCELLED, resolvedAt: new Date() },
    });
  });
}

export async function disburseLoan(
  prisma: PrismaClient,
  input: { loanId: string; lenderId: string; lenderAccountId: string; borrowerAccountId: string },
) {
  return withSerializableRetry(prisma, async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Loan" WHERE "id" = ${input.loanId}::uuid FOR UPDATE`);
    const loan = await tx.loan.findUniqueOrThrow({ where: { id: input.loanId } });
    if (loan.status !== LoanStatus.REQUESTED) throw new DomainError('loan is not awaiting disbursement');
    if (input.lenderId === loan.borrowerId) throw new DomainError('lender cannot be the borrower');
    await assertSameDemoSide(tx, input.lenderId, loan.borrowerId);
    await assertNotRestricted(tx, input.lenderId);
    await assertNoPinResetQuarantine(tx, input.lenderId);
    await requireUserCouponAccount(tx, input.lenderAccountId, input.lenderId);
    await requireUserCouponAccount(tx, input.borrowerAccountId, loan.borrowerId);
    const guarantees = await tx.guarantee.findMany({ where: { loanId: loan.id } });
    if (guarantees.length === 0 || guarantees.some((guarantee) => guarantee.status !== GuaranteeStatus.ACTIVE)) {
      throw new DomainError('all guarantees must be active before disbursement');
    }
    const transaction = await postWithClient(tx, {
      type: TransactionType.LOAN_DISBURSE,
      externalRef: `loan:${loan.id}:disburse`,
      userId: input.lenderId,
      status: TransactionStatus.CONFIRMED,
      amountCoupons: loan.principalCoupons,
      legs: [{ fromAccountId: input.lenderAccountId, toAccountId: input.borrowerAccountId, amount: loan.principalCoupons, asset: Asset.COUPON }],
    });
    return tx.loan.update({
      where: { id: loan.id },
      data: {
        lenderId: input.lenderId,
        status: LoanStatus.ACTIVE,
        outstandingCoupons: loan.principalCoupons,
        fundedAt: new Date(),
        disbursementTransactionId: transaction.id,
      },
      include: { installments: true, guarantees: true },
    });
  });
}

export async function repayLoan(
  prisma: PrismaClient,
  input: { loanId: string; amountCoupons: bigint; borrowerAccountId: string; lenderAccountId: string; externalRef: string },
) {
  if (input.amountCoupons <= 0n) throw new DomainError('repayment amount must be positive');
  return withSerializableRetry(prisma, async (tx) => {
    const existing = await tx.transaction.findUnique({ where: { externalRef: input.externalRef } });
    if (existing) return tx.loan.findUniqueOrThrow({ where: { id: input.loanId }, include: { installments: true, guarantees: true } });
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Loan" WHERE "id" = ${input.loanId}::uuid FOR UPDATE`);
    const loan = await tx.loan.findUniqueOrThrow({ where: { id: input.loanId } });
    if (loan.status !== LoanStatus.ACTIVE && loan.status !== LoanStatus.DEFAULTED) throw new DomainError('loan is not active');
    if (loan.lenderId === null) throw new DomainError('loan has no lender');
    await assertSameDemoSide(tx, loan.borrowerId, loan.lenderId);
    if (input.amountCoupons > loan.outstandingCoupons) throw new DomainError('repayment exceeds outstanding debt');
    await requireUserCouponAccount(tx, input.borrowerAccountId, loan.borrowerId);
    await requireUserCouponAccount(tx, input.lenderAccountId, loan.lenderId);
    await postWithClient(tx, {
      type: TransactionType.LOAN_REPAY,
      externalRef: input.externalRef,
      userId: loan.borrowerId,
      status: TransactionStatus.CONFIRMED,
      amountCoupons: input.amountCoupons,
      legs: [{ fromAccountId: input.borrowerAccountId, toAccountId: input.lenderAccountId, amount: input.amountCoupons, asset: Asset.COUPON }],
    });
    let remaining = input.amountCoupons;
    const installments = await tx.loanInstallment.findMany({ where: { loanId: loan.id }, orderBy: { sequence: 'asc' } });
    for (const installment of installments) {
      if (remaining === 0n) break;
      const unpaid = installment.amountCoupons - installment.paidCoupons;
      if (unpaid <= 0n) continue;
      const paid = remaining < unpaid ? remaining : unpaid;
      remaining -= paid;
      const nextPaid = installment.paidCoupons + paid;
      await tx.loanInstallment.update({
        where: { id: installment.id },
        data: { paidCoupons: nextPaid, ...(nextPaid === installment.amountCoupons ? { paidAt: new Date() } : {}) },
      });
    }
    const outstanding = loan.outstandingCoupons - input.amountCoupons;
    if (outstanding === 0n) {
      const guarantees = await tx.guarantee.findMany({ where: { loanId: loan.id, status: GuaranteeStatus.ACTIVE }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      const lockAccount = await guaranteeLockAccount(tx);
      for (const guarantee of guarantees) {
        const guarantorAccount = await userCouponAccount(tx, guarantee.guarantorId);
        await postWithClient(tx, {
          type: TransactionType.GUARANTEE_RELEASE,
          externalRef: `guarantee:${guarantee.id}:release`,
          userId: guarantee.guarantorId,
          status: TransactionStatus.CONFIRMED,
          amountCoupons: guarantee.amountCoupons,
          legs: [{ fromAccountId: lockAccount.id, toAccountId: guarantorAccount.id, amount: guarantee.amountCoupons, asset: Asset.COUPON }],
        });
        await lockUser(tx, guarantee.guarantorId);
        await tx.user.update({ where: { id: guarantee.guarantorId }, data: { activeGuaranteeCount: { decrement: 1 } } });
        await tx.guarantee.update({ where: { id: guarantee.id }, data: { status: GuaranteeStatus.RELEASED, resolvedAt: new Date() } });
      }
    }
    return tx.loan.update({
      where: { id: loan.id },
      data: { outstandingCoupons: outstanding, ...(outstanding === 0n ? { status: LoanStatus.SETTLED, settledAt: new Date() } : {}) },
      include: { installments: true, guarantees: true },
    });
  });
}

export async function claimGuarantees(prisma: PrismaClient, input: { loanId: string; lenderAccountId: string }) {
  return withSerializableRetry(prisma, async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Loan" WHERE "id" = ${input.loanId}::uuid FOR UPDATE`);
    const loan = await tx.loan.findUniqueOrThrow({ where: { id: input.loanId } });
    if (loan.status !== LoanStatus.ACTIVE) throw new DomainError('loan is not active');
    if (loan.lenderId === null) throw new DomainError('loan has no lender');
    await assertSameDemoSide(tx, loan.borrowerId, loan.lenderId);
    await requireUserCouponAccount(tx, input.lenderAccountId, loan.lenderId);
    const guarantees = await tx.guarantee.findMany({ where: { loanId: loan.id, status: GuaranteeStatus.ACTIVE }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    for (const guarantee of guarantees) await assertSameDemoSide(tx, loan.borrowerId, guarantee.guarantorId);
    if (guarantees.length === 0) throw new DomainError('loan has no active guarantees');
    const overdueInstallment = (await tx.loanInstallment.findMany({
      where: { loanId: loan.id, dueAt: { lt: new Date() } },
      select: { amountCoupons: true, paidCoupons: true },
    })).find((installment) => installment.paidCoupons < installment.amountCoupons);
    if (overdueInstallment === undefined) throw new DomainError('loan has no overdue installment');
    const totalLocked = guarantees.reduce((sum, guarantee) => sum + guarantee.amountCoupons, 0n);
    const target = loan.outstandingCoupons < totalLocked ? loan.outstandingCoupons : totalLocked;
    const claims = guarantees.map((guarantee) => (guarantee.amountCoupons * target) / totalLocked);
    let remainder = target - claims.reduce((sum, amount) => sum + amount, 0n);
    for (let index = 0; index < claims.length && remainder > 0n; index += 1, remainder -= 1n) claims[index]! += 1n;
    const lockAccount = await guaranteeLockAccount(tx);
    for (let index = 0; index < guarantees.length; index += 1) {
      const guarantee = guarantees[index]!;
      const claimed = claims[index]!;
      const surplus = guarantee.amountCoupons - claimed;
      const guarantorAccount = await userCouponAccount(tx, guarantee.guarantorId);
      if (claimed > 0n) {
        await postWithClient(tx, {
          type: TransactionType.GUARANTEE_CLAIM,
          externalRef: `guarantee:${guarantee.id}:claim`,
          ...(loan.lenderId === null ? {} : { userId: loan.lenderId }),
          status: TransactionStatus.CONFIRMED,
          amountCoupons: claimed,
          legs: [{ fromAccountId: lockAccount.id, toAccountId: input.lenderAccountId, amount: claimed, asset: Asset.COUPON }],
        });
      }
      if (surplus > 0n) {
        await postWithClient(tx, {
          type: TransactionType.GUARANTEE_RELEASE,
          externalRef: `guarantee:${guarantee.id}:release-surplus`,
          userId: guarantee.guarantorId,
          status: TransactionStatus.CONFIRMED,
          amountCoupons: surplus,
          legs: [{ fromAccountId: lockAccount.id, toAccountId: guarantorAccount.id, amount: surplus, asset: Asset.COUPON }],
        });
      }
      await lockUser(tx, guarantee.guarantorId);
      await tx.user.update({ where: { id: guarantee.guarantorId }, data: { activeGuaranteeCount: { decrement: 1 } } });
      await tx.guarantee.update({ where: { id: guarantee.id }, data: { status: GuaranteeStatus.CLAIMED, resolvedAt: new Date() } });
    }
    return tx.loan.update({
      where: { id: loan.id },
      data: { status: LoanStatus.DEFAULTED, outstandingCoupons: loan.outstandingCoupons - target },
      include: { installments: true, guarantees: true },
    });
  });
}
