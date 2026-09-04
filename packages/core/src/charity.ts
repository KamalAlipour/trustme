import { Prisma, PrismaClient, AccountType, Asset, AidRequestStatus, CharityAgentRole, PurchaseGuaranteeStatus, TransactionStatus, TransactionType } from '@trustme/db';
import { DomainError } from './domain-error.js';
import { postWithClient } from './ledger.js';
import { withSerializableRetry } from './retry.js';
import { transferCoupons } from './domain.js';
import { availableEscrowMicroUsdt, lockBalance } from './escrow-payments.js';

export async function createCharity(
  prisma: PrismaClient,
  input: { name: string; description?: string; contactEmail?: string; isActive?: boolean; adminUserId: string },
) {
  const name = input.name.trim();
  if (name.length === 0) throw new DomainError('charity name is required');
  return withSerializableRetry(prisma, async (tx) => {
    const charity = await tx.charity.create({
      data: {
        name,
        ...(input.description === undefined ? {} : { description: input.description.trim() }),
        ...(input.contactEmail === undefined ? {} : { contactEmail: input.contactEmail.trim().toLowerCase() }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      },
    });
    await tx.ledgerAccount.create({ data: { type: AccountType.CHARITY_COUPON, asset: Asset.COUPON, charityId: charity.id } });
    await tx.adminAuditLog.create({
      data: {
        adminUserId: input.adminUserId,
        action: 'charity.create',
        entityType: 'Charity',
        entityId: charity.id,
        newValue: JSON.stringify({ name: charity.name }),
      },
    });
    return charity;
  });
}

export async function updateCharity(
  prisma: PrismaClient,
  input: { charityId: string; adminUserId: string; name?: string; description?: string | null; contactEmail?: string | null; isActive?: boolean },
) {
  return withSerializableRetry(prisma, async (tx) => {
    const current = await tx.charity.findUniqueOrThrow({ where: { id: input.charityId } });
    const updated = await tx.charity.update({
      where: { id: current.id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name.trim() }),
        ...(input.description === undefined ? {} : { description: input.description === null ? null : input.description.trim() }),
        ...(input.contactEmail === undefined ? {} : { contactEmail: input.contactEmail === null ? null : input.contactEmail.trim().toLowerCase() }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      },
    });
    await tx.adminAuditLog.create({
      data: {
        adminUserId: input.adminUserId,
        action: 'charity.update',
        entityType: 'Charity',
        entityId: current.id,
        oldValue: JSON.stringify({ name: current.name, description: current.description, contactEmail: current.contactEmail, isActive: current.isActive }),
        newValue: JSON.stringify({ name: updated.name, description: updated.description, contactEmail: updated.contactEmail, isActive: updated.isActive }),
      },
    });
    return updated;
  });
}

export async function addCharityAgent(
  prisma: PrismaClient,
  input: { charityId: string; barcodeId: string; role: CharityAgentRole; adminUserId: string },
) {
  return withSerializableRetry(prisma, async (tx) => {
    const user = await tx.user.findUnique({ where: { barcodeId: input.barcodeId } });
    if (user === null) throw new DomainError('member not found', 404);
    const charity = await tx.charity.findUniqueOrThrow({ where: { id: input.charityId } });
    const existing = await tx.charityAgent.findUnique({ where: { charityId_userId: { charityId: charity.id, userId: user.id } } });
    const agent = existing === null
      ? await tx.charityAgent.create({ data: { charityId: charity.id, userId: user.id, role: input.role } })
      : await tx.charityAgent.update({ where: { id: existing.id }, data: { role: input.role, revokedAt: null } });
    await tx.adminAuditLog.create({
      data: {
        adminUserId: input.adminUserId,
        action: 'charity.agent.add',
        entityType: 'CharityAgent',
        entityId: agent.id,
        newValue: JSON.stringify({ charityId: charity.id, userId: user.id, role: input.role }),
      },
    });
    return agent;
  });
}

export async function revokeCharityAgent(prisma: PrismaClient, input: { charityId: string; userId: string; adminUserId: string }) {
  return withSerializableRetry(prisma, async (tx) => {
    const agent = await tx.charityAgent.findUnique({ where: { charityId_userId: { charityId: input.charityId, userId: input.userId } } });
    if (agent === null) throw new DomainError('resource not found', 404);
    const updated = await tx.charityAgent.update({ where: { id: agent.id }, data: { revokedAt: new Date() } });
    await tx.adminAuditLog.create({
      data: {
        adminUserId: input.adminUserId,
        action: 'charity.agent.revoke',
        entityType: 'CharityAgent',
        entityId: agent.id,
        oldValue: JSON.stringify({ revokedAt: agent.revokedAt }),
        newValue: JSON.stringify({ revokedAt: updated.revokedAt }),
      },
    });
    return updated;
  });
}

export async function donateToCharity(prisma: PrismaClient, input: { memberId: string; memberAccountId: string; charityAccountId: string; amountCoupons: bigint; externalRef: string }) {
  return transferCoupons(prisma, {
    userId: input.memberId,
    fromAccountId: input.memberAccountId,
    toAccountId: input.charityAccountId,
    amountCoupons: input.amountCoupons,
    externalRef: input.externalRef,
  });
}

async function attachMedia(tx: Prisma.TransactionClient, ownerId: string, mediaIds: readonly string[], aidRequestId: string): Promise<void> {
  if (mediaIds.length > 10) throw new DomainError('no more than 10 media assets may be attached');
  if (mediaIds.length === 0) return;
  const found = await tx.mediaAsset.findMany({ where: { id: { in: [...new Set(mediaIds)] }, ownerId, refundRequestId: null, aidRequestId: null }, select: { id: true } });
  if (found.length !== new Set(mediaIds).size) throw new DomainError('invalid media asset');
  const updated = await tx.mediaAsset.updateMany({ where: { id: { in: [...new Set(mediaIds)] }, ownerId, refundRequestId: null, aidRequestId: null }, data: { aidRequestId } });
  if (updated.count !== new Set(mediaIds).size) throw new DomainError('invalid media asset');
}

export async function createAidRequest(
  prisma: PrismaClient,
  input: { applicantId: string; charityId: string; amountCoupons: bigint; description: string; loanId?: string; mediaIds?: readonly string[] },
) {
  if (input.amountCoupons <= 0n) throw new DomainError('aid amount must be positive');
  if (input.description.trim().length === 0) throw new DomainError('aid description is required');
  return withSerializableRetry(prisma, async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${input.applicantId}::uuid FOR UPDATE`);
    const applicant = await tx.user.findUniqueOrThrow({ where: { id: input.applicantId }, select: { isDemo: true } });
    if (applicant.isDemo) throw new DomainError('demo accounts cannot request aid');
    const charity = await tx.charity.findUnique({ where: { id: input.charityId } });
    if (charity === null || !charity.isActive) throw new DomainError('charity not found', 404);
    if (input.loanId !== undefined) {
      const loan = await tx.loan.findUnique({ where: { id: input.loanId } });
      if (loan === null || loan.borrowerId !== input.applicantId) throw new DomainError('resource not found', 404);
    }
    const open = await tx.aidRequest.count({
      where: { applicantId: input.applicantId, charityId: charity.id, status: { in: [AidRequestStatus.PENDING, AidRequestStatus.DOCUMENTS_REQUESTED] } },
    });
    if (open >= 3) throw new DomainError('too many open aid requests');
    const request = await tx.aidRequest.create({
      data: {
        applicantId: input.applicantId,
        charityId: charity.id,
        ...(input.loanId === undefined ? {} : { loanId: input.loanId }),
        amountCoupons: input.amountCoupons,
        description: input.description.trim(),
      },
    });
    await attachMedia(tx, input.applicantId, input.mediaIds ?? [], request.id);
    return request;
  });
}

export async function attachAidDocuments(prisma: PrismaClient, input: { aidRequestId: string; applicantId: string; mediaIds: readonly string[] }) {
  return withSerializableRetry(prisma, async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "AidRequest" WHERE "id" = ${input.aidRequestId}::uuid FOR UPDATE`);
    const request = await tx.aidRequest.findUniqueOrThrow({ where: { id: input.aidRequestId } });
    if (request.applicantId !== input.applicantId) throw new DomainError('forbidden', 403);
    const applicant = await tx.user.findUniqueOrThrow({ where: { id: request.applicantId }, select: { isDemo: true } });
    if (applicant.isDemo) throw new DomainError('demo accounts cannot request aid');
    if (request.status !== AidRequestStatus.DOCUMENTS_REQUESTED) throw new DomainError('documents are not requested', 409);
    await attachMedia(tx, input.applicantId, input.mediaIds, request.id);
    return tx.aidRequest.update({ where: { id: request.id }, data: { status: AidRequestStatus.PENDING } });
  });
}

async function assertAgent(tx: Prisma.TransactionClient, charityId: string, userId: string): Promise<void> {
  const agent = await tx.charityAgent.findFirst({ where: { charityId, userId, revokedAt: null } });
  if (agent === null) throw new DomainError('resource not found', 404);
}

async function createPurchaseGuaranteeWithClient(
  tx: Prisma.TransactionClient,
  input: { charityId: string; guarantorId: string; beneficiaryId: string; amountMicroUsdt: bigint; aidRequestId?: string; note?: string },
) {
  if (input.amountMicroUsdt <= 0n) throw new DomainError('guarantee amount must be positive');
  if (input.guarantorId === input.beneficiaryId) throw new DomainError('guarantor and beneficiary must be different');
  await assertAgent(tx, input.charityId, input.guarantorId);
  const beneficiary = await tx.user.findUniqueOrThrow({ where: { id: input.beneficiaryId }, select: { isDemo: true } });
  if (beneficiary.isDemo) throw new DomainError('demo accounts cannot receive guarantees');
  const balance = await lockBalance(tx, input.guarantorId);
  if (input.amountMicroUsdt > availableEscrowMicroUsdt(balance)) throw new DomainError('guarantee exceeds available escrow', 409);
  await tx.escrowBalance.update({ where: { userId: input.guarantorId }, data: { reservedMicroUsdt: { increment: input.amountMicroUsdt } } });
  return tx.purchaseGuarantee.create({
    data: {
      charityId: input.charityId,
      guarantorId: input.guarantorId,
      beneficiaryId: input.beneficiaryId,
      amountMicroUsdt: input.amountMicroUsdt,
      remainingMicroUsdt: input.amountMicroUsdt,
      ...(input.aidRequestId === undefined ? {} : { aidRequestId: input.aidRequestId }),
      ...(input.note === undefined ? {} : { note: input.note.trim() || null }),
    },
  });
}

export async function createPurchaseGuarantee(
  prisma: PrismaClient,
  input: { charityId: string; guarantorId: string; beneficiaryId: string; amountMicroUsdt: bigint; aidRequestId?: string; note?: string },
) {
  return withSerializableRetry(prisma, (tx) => createPurchaseGuaranteeWithClient(tx, input));
}

export async function revokePurchaseGuarantee(prisma: PrismaClient, input: { guaranteeId: string; agentId: string }) {
  return withSerializableRetry(prisma, async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "PurchaseGuarantee" WHERE "id" = ${input.guaranteeId}::uuid FOR UPDATE`);
    const guarantee = await tx.purchaseGuarantee.findUniqueOrThrow({ where: { id: input.guaranteeId } });
    await assertAgent(tx, guarantee.charityId, input.agentId);
    if (guarantee.status !== PurchaseGuaranteeStatus.ACTIVE && guarantee.status !== PurchaseGuaranteeStatus.EXHAUSTED) {
      throw new DomainError('guarantee is already revoked', 409);
    }
    const balance = await lockBalance(tx, guarantee.guarantorId);
    if (balance.reservedMicroUsdt < guarantee.remainingMicroUsdt) throw new DomainError('guarantee reservation is inconsistent');
    await tx.escrowBalance.update({ where: { userId: guarantee.guarantorId }, data: { reservedMicroUsdt: { decrement: guarantee.remainingMicroUsdt } } });
    return tx.purchaseGuarantee.update({
      where: { id: guarantee.id },
      data: { status: PurchaseGuaranteeStatus.REVOKED, closedAt: new Date() },
    });
  });
}

export async function approveAidRequest(
  prisma: PrismaClient,
  input: { aidRequestId: string; agentId: string; approvedCoupons?: bigint; note?: string; mode?: 'TRANSFER' | 'GUARANTEE' },
) {
  return withSerializableRetry(prisma, async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "AidRequest" WHERE "id" = ${input.aidRequestId}::uuid FOR UPDATE`);
    const request = await tx.aidRequest.findUniqueOrThrow({ where: { id: input.aidRequestId } });
    await assertAgent(tx, request.charityId, input.agentId);
    const applicant = await tx.user.findUniqueOrThrow({ where: { id: request.applicantId }, select: { isDemo: true } });
    if (applicant.isDemo) throw new DomainError('demo accounts cannot request aid');
    if (request.status !== AidRequestStatus.PENDING) throw new DomainError('aid request is not pending', 409);
    const amount = input.approvedCoupons ?? request.amountCoupons;
    if (amount <= 0n || amount > request.amountCoupons) throw new DomainError('approved amount cannot exceed requested amount');
    if (input.mode === 'GUARANTEE') {
      await createPurchaseGuaranteeWithClient(tx, {
        charityId: request.charityId,
        guarantorId: input.agentId,
        beneficiaryId: request.applicantId,
        amountMicroUsdt: amount * 10_000n,
        aidRequestId: request.id,
        ...(input.note === undefined ? {} : { note: input.note }),
      });
      return tx.aidRequest.update({
        where: { id: request.id },
        data: {
          status: AidRequestStatus.GUARANTEED,
          approvedCoupons: amount,
          decisionNote: input.note?.trim() || null,
          decidedById: input.agentId,
          decidedAt: new Date(),
        },
        include: { guarantee: true },
      });
    }
    const charityAccount = await tx.ledgerAccount.findFirstOrThrow({ where: { charityId: request.charityId, type: AccountType.CHARITY_COUPON, asset: Asset.COUPON } });
    const applicantAccount = await tx.ledgerAccount.findFirstOrThrow({ where: { userId: request.applicantId, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "LedgerAccount" WHERE "id" = ${charityAccount.id}::uuid FOR UPDATE`);
    const lockedCharityAccount = await tx.ledgerAccount.findUniqueOrThrow({ where: { id: charityAccount.id } });
    if (lockedCharityAccount.balance < amount) throw new DomainError('insufficient charity balance', 409);
    const transaction = await postWithClient(tx, {
      type: TransactionType.TRANSFER,
      externalRef: `aid:${request.id}`,
      userId: input.agentId,
      status: TransactionStatus.CONFIRMED,
      amountCoupons: amount,
      legs: [{ fromAccountId: charityAccount.id, toAccountId: applicantAccount.id, amount, asset: Asset.COUPON }],
    });
    return tx.aidRequest.update({
      where: { id: request.id },
      data: {
        status: AidRequestStatus.APPROVED,
        approvedCoupons: amount,
        decisionNote: input.note?.trim() || null,
        decidedById: input.agentId,
        decidedAt: new Date(),
        disbursementTransactionId: transaction.id,
      },
      include: { guarantee: true },
    });
  });
}

export async function rejectAidRequest(prisma: PrismaClient, input: { aidRequestId: string; agentId: string; note: string }) {
  const note = input.note.trim();
  if (note.length === 0) throw new DomainError('rejection note is required');
  return withSerializableRetry(prisma, async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "AidRequest" WHERE "id" = ${input.aidRequestId}::uuid FOR UPDATE`);
    const request = await tx.aidRequest.findUniqueOrThrow({ where: { id: input.aidRequestId } });
    await assertAgent(tx, request.charityId, input.agentId);
    if (request.status !== AidRequestStatus.PENDING && request.status !== AidRequestStatus.DOCUMENTS_REQUESTED) throw new DomainError('aid request is not open', 409);
    return tx.aidRequest.update({ where: { id: request.id }, data: { status: AidRequestStatus.REJECTED, decisionNote: note, decidedById: input.agentId, decidedAt: new Date() } });
  });
}

export async function requestAidDocuments(prisma: PrismaClient, input: { aidRequestId: string; agentId: string; note: string }) {
  const note = input.note.trim();
  if (note.length === 0) throw new DomainError('document request note is required');
  return withSerializableRetry(prisma, async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "AidRequest" WHERE "id" = ${input.aidRequestId}::uuid FOR UPDATE`);
    const request = await tx.aidRequest.findUniqueOrThrow({ where: { id: input.aidRequestId } });
    await assertAgent(tx, request.charityId, input.agentId);
    if (request.status !== AidRequestStatus.PENDING) throw new DomainError('aid request is not pending', 409);
    return tx.aidRequest.update({ where: { id: request.id }, data: { status: AidRequestStatus.DOCUMENTS_REQUESTED, decisionNote: note, decidedById: input.agentId } });
  });
}
