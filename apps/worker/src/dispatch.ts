import { getAddress, Interface, keccak256, type TransactionRequest } from 'ethers';
import { AccountType, Asset, Prisma, PrismaClient, TransactionStatus, TransactionType, WithdrawalStatus } from '@trustme/db';
import { postTransaction, withSerializableRetry } from '@trustme/core';
import type { ChainProvider, ChainReceipt, TransactionSigner } from './provider.js';

const usdtInterface = new Interface(['function transfer(address to, uint256 amount) returns (bool)']);

export type DispatchConfig = {
  usdtContractAddress: string;
  confirmations: number;
};

export type DispatchResult =
  | { status: 'skipped' }
  | { status: 'broadcast'; txHash: string }
  | { status: 'watching'; txHash: string };

async function claimApprovedWithdrawal(prisma: PrismaClient, withdrawalId: string) {
  return withSerializableRetry(prisma, async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Withdrawal" WHERE "id" = ${withdrawalId}::uuid FOR UPDATE`);
    const withdrawal = await tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
    if (withdrawal.chainTxHash !== null) return withdrawal;
    if (withdrawal.status !== WithdrawalStatus.APPROVED) return null;
    return tx.withdrawal.update({ where: { id: withdrawalId }, data: { status: WithdrawalStatus.PROCESSING } });
  });
}

function feeFields(fees: Awaited<ReturnType<ChainProvider['estimateFees']>>): Pick<TransactionRequest, 'gasPrice' | 'maxFeePerGas' | 'maxPriorityFeePerGas'> {
  if (fees.maxFeePerGas !== undefined && fees.maxPriorityFeePerGas !== undefined) {
    return { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
  }
  return fees.gasPrice === undefined ? {} : { gasPrice: fees.gasPrice };
}

function isKnownBroadcastError(error: unknown, expectedHash: string): boolean {
  if (!(error instanceof Error)) return false;
  if (/already known/i.test(error.message)) return true;
  if (!/nonce too low/i.test(error.message)) return false;
  const details = error as Error & { hash?: unknown; transactionHash?: unknown; txHash?: unknown };
  return [details.hash, details.transactionHash, details.txHash].some(
    (value) => typeof value === 'string' && value.toLowerCase() === expectedHash.toLowerCase(),
  ) || error.message.toLowerCase().includes(expectedHash.toLowerCase());
}

export async function dispatchWithdrawal(
  prisma: PrismaClient,
  provider: ChainProvider,
  signer: TransactionSigner,
  config: DispatchConfig,
  withdrawalId: string,
): Promise<DispatchResult> {
  const withdrawal = await claimApprovedWithdrawal(prisma, withdrawalId);
  if (withdrawal === null) return { status: 'skipped' };
  if (withdrawal.chainTxHash !== null) return { status: 'watching', txHash: withdrawal.chainTxHash };
  const fees = await provider.estimateFees();
  const transaction: TransactionRequest = {
    to: config.usdtContractAddress,
    data: usdtInterface.encodeFunctionData('transfer', [getAddress(withdrawal.destinationAddress), withdrawal.netMicroUsdt]),
    nonce: await provider.getTransactionCount(signer.address),
    ...feeFields(fees),
  };
  const signedTransaction = await signer.signTransaction(transaction);
  const txHash = keccak256(signedTransaction);
  await prisma.withdrawal.update({
    where: { id: withdrawal.id },
    data: { chainTxHash: txHash, broadcastedAt: new Date() },
  });
  try {
    await provider.sendTransaction(signedTransaction);
  } catch (error) {
    if (!isKnownBroadcastError(error, txHash)) throw error;
  }
  return { status: 'broadcast', txHash };
}

async function systemAccount(prisma: PrismaClient, type: AccountType) {
  return prisma.ledgerAccount.findFirstOrThrow({ where: { type, asset: Asset.USDT, userId: null } });
}

export type ConfirmationResult =
  | { status: 'waiting'; txHash: string }
  | { status: 'failed'; txHash: string }
  | { status: 'completed'; txHash: string };

export async function confirmWithdrawal(
  prisma: PrismaClient,
  provider: ChainProvider,
  config: DispatchConfig,
  withdrawalId: string,
  log: Pick<Console, 'error'> = console,
): Promise<ConfirmationResult | null> {
  const withdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
  if (!withdrawal || withdrawal.chainTxHash === null) return null;
  const receipt: ChainReceipt | null = await provider.getTransactionReceipt(withdrawal.chainTxHash);
  if (receipt === null) return { status: 'waiting', txHash: withdrawal.chainTxHash };
  if (receipt.status !== 1) {
    await prisma.withdrawal.update({ where: { id: withdrawal.id }, data: { status: WithdrawalStatus.FAILED } });
    log.error(`withdrawal ${withdrawal.id} reverted on-chain; manual review required`);
    return { status: 'failed', txHash: withdrawal.chainTxHash };
  }
  const head = await provider.getBlockNumber();
  if (head - receipt.blockNumber + 1 < config.confirmations) {
    return { status: 'waiting', txHash: withdrawal.chainTxHash };
  }
  const pending = await systemAccount(prisma, AccountType.SYSTEM_WITHDRAWAL_PENDING);
  const external = await systemAccount(prisma, AccountType.EXTERNAL_ONCHAIN);
  await postTransaction(prisma, {
    type: TransactionType.WITHDRAWAL,
    externalRef: `withdrawal:${withdrawal.id}:settle`,
    userId: withdrawal.userId,
    status: TransactionStatus.CONFIRMED,
    amountMicroUsdt: withdrawal.netMicroUsdt,
    legs: [{ fromAccountId: pending.id, toAccountId: external.id, amount: withdrawal.netMicroUsdt, asset: Asset.USDT }],
  });
  await prisma.withdrawal.update({ where: { id: withdrawal.id }, data: { status: WithdrawalStatus.COMPLETED } });
  return { status: 'completed', txHash: withdrawal.chainTxHash };
}
