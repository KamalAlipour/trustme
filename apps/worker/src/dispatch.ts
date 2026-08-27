import { getAddress, Interface, keccak256, type TransactionRequest } from 'ethers';
import { AccountType, Asset, Prisma, PrismaClient, TransactionStatus, TransactionType, WithdrawalStatus } from '@trustme/db';
import { getHotWalletBalances as readHotWalletBalances, postTransaction, withSerializableRetry } from '@trustme/core';
import type { ChainProvider, ChainReceipt, TransactionSigner } from './provider.js';

const usdtInterface = new Interface(['function transfer(address to, uint256 amount) returns (bool)']);

export type DispatchConfig = {
  usdtContractAddress: string;
  chainId: number;
  confirmations: number;
  gasSafetyMultiplierBps: number;
  gasLimitCeiling: number;
  chainMaxBlockAgeSeconds?: number;
};

export class WithdrawalNotEligibleError extends Error {
  public constructor() {
    super('withdrawal cooldown has not elapsed');
    this.name = 'WithdrawalNotEligibleError';
  }
}

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
    if (withdrawal.eligibleAt > new Date()) throw new WithdrawalNotEligibleError();
    return tx.withdrawal.update({ where: { id: withdrawalId }, data: { status: WithdrawalStatus.PROCESSING } });
  });
}

function feeFields(fees: Awaited<ReturnType<ChainProvider['estimateFees']>>): Pick<TransactionRequest, 'gasPrice' | 'maxFeePerGas' | 'maxPriorityFeePerGas'> {
  if (fees.maxFeePerGas !== undefined && fees.maxPriorityFeePerGas !== undefined) {
    return { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
  }
  return fees.gasPrice === undefined ? {} : { gasPrice: fees.gasPrice };
}

function feeFieldsWithType(
  fees: Awaited<ReturnType<ChainProvider['estimateFees']>>,
): Pick<TransactionRequest, 'gasPrice' | 'maxFeePerGas' | 'maxPriorityFeePerGas' | 'type'> {
  if (fees.maxFeePerGas !== undefined && fees.maxPriorityFeePerGas !== undefined) {
    return { ...feeFields(fees), type: 2 };
  }
  if (fees.gasPrice !== undefined) return { gasPrice: fees.gasPrice, type: 0 };
  throw new Error('provider returned no usable fee estimate');
}

function calculateGasLimit(estimatedGas: bigint, config: DispatchConfig): bigint {
  if (estimatedGas <= 0n) throw new Error('provider returned an invalid gas estimate');
  const gasLimit = (estimatedGas * BigInt(config.gasSafetyMultiplierBps) + 9_999n) / 10_000n;
  if (gasLimit > BigInt(config.gasLimitCeiling)) throw new Error('estimated gas exceeds configured ceiling');
  return gasLimit;
}

export const getHotWalletBalances = readHotWalletBalances;

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
  log: Pick<Console, 'error'> = console,
): Promise<DispatchResult> {
  const withdrawal = await claimApprovedWithdrawal(prisma, withdrawalId);
  if (withdrawal === null) return { status: 'skipped' };
  if (withdrawal.chainTxHash !== null) return { status: 'watching', txHash: withdrawal.chainTxHash };
  let signedTransaction: string;
  let txHash: string;
  try {
    const head = await provider.getBlockNumber();
    const cursor = await prisma.chainCursor.findUnique({ where: { id: 1 }, select: { nextBlock: true } });
    if (cursor !== null && BigInt(head) < cursor.nextBlock) throw new Error('chain head is behind the stored cursor');
    const blockTimestamp = await provider.getBlockTimestamp(head);
    if (blockTimestamp === null || Math.floor(Date.now() / 1000) - blockTimestamp > (config.chainMaxBlockAgeSeconds ?? 120)) {
      throw new Error('chain head is stale');
    }
    const fees = await provider.estimateFees();
    const feeTransaction = feeFieldsWithType(fees);
    const transactionWithoutGas: TransactionRequest = {
      to: config.usdtContractAddress,
      data: usdtInterface.encodeFunctionData('transfer', [getAddress(withdrawal.destinationAddress), withdrawal.netMicroUsdt]),
      chainId: config.chainId,
      nonce: await provider.getTransactionCount(signer.address, 'pending'),
      ...feeTransaction,
    };
    const estimatedGas = await provider.estimateGas({ ...transactionWithoutGas, from: signer.address });
    const gasLimit = calculateGasLimit(estimatedGas, config);
    const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice;
    if (maxFeePerGas === undefined) throw new Error('provider returned no usable fee estimate');
    const requiredNativeBalance = gasLimit * maxFeePerGas;
    const balances = await getHotWalletBalances(provider, config.usdtContractAddress, signer.address);
    if (balances.usdtBalanceMicroUsdt < withdrawal.netMicroUsdt) {
      log.error(`hot wallet has insufficient USDT for withdrawal ${withdrawal.id}`);
      throw new Error('hot wallet has insufficient USDT');
    }
    if (balances.nativeBalanceWei < requiredNativeBalance) {
      log.error(`hot wallet has insufficient native balance for withdrawal ${withdrawal.id}`);
      throw new Error('hot wallet has insufficient native balance');
    }
    const transaction: TransactionRequest = { ...transactionWithoutGas, gasLimit };
    signedTransaction = await signer.signTransaction(transaction);
    txHash = keccak256(signedTransaction);
    await prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: { chainTxHash: txHash, broadcastedAt: new Date() },
    });
  } catch (error) {
    await prisma.withdrawal.updateMany({
      where: { id: withdrawal.id, status: WithdrawalStatus.PROCESSING, chainTxHash: null },
      data: { status: WithdrawalStatus.APPROVED },
    });
    throw error;
  }
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
