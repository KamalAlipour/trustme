import {
  AccountType,
  Asset,
  Prisma,
  PrismaClient,
  TransactionStatus,
  TransactionType,
} from '@trustme/db';

export type DbClient = PrismaClient | Prisma.TransactionClient;
export type LedgerLeg = {
  fromAccountId: string;
  toAccountId: string;
  amount: bigint;
  asset: Asset;
};

export type PostTransactionInput = {
  type: TransactionType;
  externalRef: string;
  legs: readonly LedgerLeg[];
  userId?: string;
  status?: TransactionStatus;
  txHash?: string;
  amountMicroUsdt?: bigint;
  amountCoupons?: bigint;
  feeMicroUsdt?: bigint;
  roundingDustMicroUsdt?: bigint;
};

const serializable = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } as const;

function validateLegs(legs: readonly LedgerLeg[]): void {
  if (legs.length === 0) throw new Error('transaction requires at least one leg');
  for (const leg of legs) {
    if (leg.amount <= 0n) throw new Error('ledger amounts must be positive');
    if (leg.fromAccountId === leg.toAccountId) throw new Error('ledger accounts must differ');
  }
}

function netChanges(legs: readonly LedgerLeg[]): Map<string, bigint> {
  const changes = new Map<string, bigint>();
  for (const leg of legs) {
    changes.set(leg.fromAccountId, (changes.get(leg.fromAccountId) ?? 0n) - leg.amount);
    changes.set(leg.toAccountId, (changes.get(leg.toAccountId) ?? 0n) + leg.amount);
  }
  return changes;
}

async function postWithClient(client: Prisma.TransactionClient, input: PostTransactionInput) {
  validateLegs(input.legs);
  const existing = await client.transaction.findUnique({ where: { externalRef: input.externalRef } });
  if (existing) return existing;

  const ids = [...new Set(input.legs.flatMap((leg) => [leg.fromAccountId, leg.toAccountId]))].sort();
  const locked = await client.$queryRaw<Array<{ id: string; type: AccountType; asset: Asset; balance: bigint }>>(
    Prisma.sql`SELECT "id", "type", "asset", "balance" FROM "LedgerAccount" WHERE "id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY "id" ASC FOR UPDATE`,
  );
  if (locked.length !== ids.length) throw new Error('one or more ledger accounts do not exist');
  const accountAssets = new Map(locked.map((account) => [account.id, account.asset]));
  const accountBalances = new Map(locked.map((account) => [account.id, account.balance]));
  for (const leg of input.legs) {
    if (accountAssets.get(leg.fromAccountId) !== leg.asset || accountAssets.get(leg.toAccountId) !== leg.asset) {
      throw new Error('ledger leg asset does not match account asset');
    }
  }
  for (const [accountId, change] of netChanges(input.legs)) {
    const account = locked.find((candidate) => candidate.id === accountId);
    const balance = accountBalances.get(accountId);
    if (!account || balance === undefined) throw new Error('one or more ledger accounts do not exist');
    const resultingBalance = balance + change;
    if (account.type === AccountType.SYSTEM_COUPON_ISSUANCE && resultingBalance > 0n) {
      throw new Error('coupon issuance account cannot be positive');
    }
    if (account.type !== AccountType.SYSTEM_COUPON_ISSUANCE && account.type !== AccountType.EXTERNAL_ONCHAIN && resultingBalance < 0n) {
      throw new Error('ledger account balance cannot be negative');
    }
  }

  const transaction = await client.transaction.create({
    data: {
      type: input.type,
      externalRef: input.externalRef,
      ...(input.userId === undefined ? {} : { userId: input.userId }),
      ...(input.txHash === undefined ? {} : { txHash: input.txHash }),
      status: input.status ?? TransactionStatus.PENDING,
      amountMicroUsdt: input.amountMicroUsdt ?? 0n,
      amountCoupons: input.amountCoupons ?? 0n,
      feeMicroUsdt: input.feeMicroUsdt ?? 0n,
      roundingDustMicroUsdt: input.roundingDustMicroUsdt ?? 0n,
    },
  });
  for (const [accountId, change] of netChanges(input.legs)) {
    if (change < 0n) {
      await client.ledgerAccount.updateMany({ where: { id: accountId }, data: { balance: { decrement: -change } } });
    } else if (change > 0n) {
      await client.ledgerAccount.updateMany({ where: { id: accountId }, data: { balance: { increment: change } } });
    }
  }
  await client.ledgerEntry.createMany({
    data: input.legs.map((leg) => ({
      transactionId: transaction.id,
      fromAccountId: leg.fromAccountId,
      toAccountId: leg.toAccountId,
      amount: leg.amount,
      asset: leg.asset,
    })),
  });
  return transaction;
}

export async function postTransaction(prisma: PrismaClient, input: PostTransactionInput) {
  validateLegs(input.legs);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await prisma.$transaction((tx: Prisma.TransactionClient) => postWithClient(tx, input), serializable);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await prisma.transaction.findUnique({ where: { externalRef: input.externalRef } });
        if (existing) return existing;
      }
      const serializationFailure =
        (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2034' || /40001|serialize|deadlock/i.test(error.message))) ||
        (error instanceof Prisma.PrismaClientUnknownRequestError && /serialize|deadlock/i.test(error.message));
      if (!serializationFailure) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, (attempt % 5) * 10 + 1));
    }
  }
  throw new Error('serializable transaction failed after 50 retries');
}

export { postWithClient };
