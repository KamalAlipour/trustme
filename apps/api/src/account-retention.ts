import { Prisma, PrismaClient } from '@trustme/db';
import { withSerializableRetry } from '@trustme/core';

async function hasProtectiveHistory(tx: Prisma.TransactionClient, userId: string): Promise<boolean> {
  const checks = await Promise.all([
    tx.identityCheck.count({ where: { userId } }),
    tx.identityReview.count({ where: { userId } }),
    tx.bankAccountCheck.count({ where: { userId } }),
    tx.balanceDisclosureRequest.count({ where: { userId } }),
    tx.identityCaptureSession.count({ where: { userId } }),
    tx.identityLoginAttempt.count({ where: { userId } }),
    tx.memberWallet.count({ where: { userId } }),
    tx.escrowBalance.count({ where: { userId, OR: [{ lockedMicroUsdt: { gt: 0 } }, { reservedMicroUsdt: { gt: 0 } }] } }),
    tx.escrowChainEvent.count({ where: { userId } }),
    tx.escrowPermitDeposit.count({ where: { userId } }),
    tx.escrowUnload.count({ where: { userId } }),
    tx.escrowSettlement.count({ where: { OR: [{ buyerId: userId }, { payerId: userId }, { merchantId: userId }] } }),
    tx.loan.count({ where: { OR: [{ borrowerId: userId }, { lenderId: userId }, { requestedLenderId: userId }] } }),
    tx.guarantee.count({ where: { guarantorId: userId } }),
    tx.purchaseGuarantee.count({ where: { OR: [{ guarantorId: userId }, { beneficiaryId: userId }] } }),
    tx.refundRequest.count({ where: { OR: [{ buyerId: userId }, { sellerId: userId }] } }),
    tx.aidRequest.count({ where: { OR: [{ applicantId: userId }, { decidedById: userId }] } }),
    tx.mediaAsset.count({ where: { ownerId: userId } }),
    tx.transaction.count({ where: { userId } }),
    tx.ledgerEntry.count({ where: { OR: [{ fromAccount: { userId } }, { toAccount: { userId } }] } }),
    tx.depositSweep.count({
      where: {
        depositAddress: { userId },
        OR: [
          { amountMicroUsdt: { gt: 0 } },
          { gasTxHash: { not: null } },
          { sweepTxHash: { not: null } },
          { status: { not: 'PENDING' } },
        ],
      },
    }),
    tx.escrowHold.count({ where: { OR: [{ senderId: userId }, { recipientId: userId }] } }),
    tx.withdrawal.count({ where: { userId } }),
    tx.payCode.count({ where: { OR: [{ buyerId: userId }, { merchantId: userId }] } }),
    tx.commissionDispute.count({ where: { OR: [{ sellerId: userId }, { marketerId: userId }] } }),
    tx.commissionPayout.count({ where: { OR: [{ recipientId: userId }, { sourceUserId: userId }] } }),
    tx.apiKey.count({ where: { partnerUserId: userId } }),
    tx.partnerBuyer.count({ where: { OR: [{ partnerUserId: userId }, { userId }] } }),
    tx.partnerDepositNotice.count({ where: { OR: [{ partnerUserId: userId }, { buyerUserId: userId }] } }),
    tx.partnerCheckout.count({ where: { OR: [{ partnerUserId: userId }, { buyerUserId: userId }, { sellerUserId: userId }] } }),
    tx.charityAgent.count({ where: { userId } }),
  ]);
  return checks.some((count) => count > 0);
}

export async function isAccountDeletable(tx: Prisma.TransactionClient, userId: string): Promise<boolean> {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: {
      isDemo: true,
      identityVerificationStatus: true,
      identityVerifiedAt: true,
      marketerId: true,
      trainerId: true,
      dustMicroUsdt: true,
      activeGuaranteeCount: true,
    },
  });
  if (user === null ||
      user.isDemo ||
      user.identityVerificationStatus === 'VERIFIED' ||
      user.identityVerifiedAt !== null ||
      user.marketerId !== null ||
      user.trainerId !== null ||
      user.dustMicroUsdt !== 0n ||
      user.activeGuaranteeCount !== 0) {
    return false;
  }
  return !(await hasProtectiveHistory(tx, userId));
}

export async function deleteEmptyAccount(prisma: PrismaClient, userId: string, reason: string): Promise<boolean> {
  try {
    return await withSerializableRetry(prisma, async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId}::uuid FOR UPDATE`;
      if (!await isAccountDeletable(tx, userId)) return false;
      await tx.depositSweep.deleteMany({ where: { depositAddress: { userId } } });
      await tx.memberDevice.deleteMany({ where: { userId } });
      await tx.emailVerification.deleteMany({ where: { userId } });
      await tx.phoneVerification.deleteMany({ where: { userId } });
      await tx.userIdentity.deleteMany({ where: { userId } });
      await tx.contact.deleteMany({ where: { OR: [{ ownerId: userId }, { contactUserId: userId }] } });
      await tx.ledgerAccount.deleteMany({ where: { userId } });
      await tx.escrowBalance.deleteMany({ where: { userId } });
      await tx.depositAddress.deleteMany({ where: { userId } });
      await tx.user.delete({ where: { id: userId } });
      return true;
    });
  } catch (error) {
    console.warn(
      '[account-retention] delete skipped',
      userId,
      reason,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}
