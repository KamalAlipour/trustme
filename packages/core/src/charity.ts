import { Prisma, PrismaClient, AccountType, Asset, AidRequestStatus, CharityAgentRole, TransactionStatus, TransactionType } from '@trustme/db';
import { DomainError } from './domain-error.js';
import { postWithClient } from './ledger.js';
import { withSerializableRetry } from './retry.js';
import { transferCoupons } from './domain.js';

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
    if (applicant.isDemo) throw new DomainError('demo and real accounts cannot exchange coupons');
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
    const applicant = await tx.user.findUniqueOrThrow({ where: { id: request.applicantId }, select: { isDemo: true } });
    if (applicant.isDemo) throw new DomainError('demo and real accounts cannot exchange coupons');
    if (request.applicantId !== input.applicantId) throw new DomainError('forbidden', 403);
    if (request.status !== AidRequestStatus.DOCUMENTS_REQUESTED) throw new DomainError('documents are not requested', 409);
    await attachMedia(tx, input.applicantId, input.mediaIds, request.id);
    return tx.aidRequest.update({ where: { id: request.id }, data: { status: AidRequestStatus.PENDING } });
  });
}

async function assertAgent(tx: Prisma.TransactionClient, charityId: string, userId: string): Promise<void> {
  const agent = await tx.charityAgent.findFirst({ where: { charityId, userId, revokedAt: null } });
  if (agent === null) throw new DomainError('resource not found', 404);
}

export async function approveAidRequest(
  prisma: PrismaClient,
  input: { aidRequestId: string; agentId: string; approvedCoupons?: bigint; note?: string },
) {
  return withSerializableRetry(prisma, async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "AidRequest" WHERE "id" = ${input.aidRequestId}::uuid FOR UPDATE`);
    const request = await tx.aidRequest.findUniqueOrThrow({ where: { id: input.aidRequestId } });
    await assertAgent(tx, request.charityId, input.agentId);
    if (request.status !== AidRequestStatus.PENDING) throw new DomainError('aid request is not pending', 409);
    const amount = input.approvedCoupons ?? request.amountCoupons;
    if (amount <= 0n || amount > request.amountCoupons) throw new DomainError('approved amount cannot exceed requested amount');
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
