import { HDNodeWallet, getAddress, Interface, keccak256, type TransactionRequest } from 'ethers';
import { DepositSweepStatus, Prisma, PrismaClient } from '@trustme/db';
import { withSerializableRetry } from '@trustme/core';
import { assertChainHealthy } from './chain-health.js';
import { calculateGasLimit, feeFieldsWithType, isKnownBroadcastError, type DispatchConfig } from './dispatch.js';
import type { ChainProvider, TransactionSigner } from './provider.js';

const usdtInterface = new Interface(['function transfer(address to, uint256 amount) returns (bool)']);
const transferStatuses = { in: [DepositSweepStatus.PENDING, DepositSweepStatus.GAS_FUNDING, DepositSweepStatus.BROADCAST] };

export type SweepConfig = DispatchConfig & {
  hotWalletAddress: string;
  sweepMinMicroUsdt: number;
  sweepMaxGasTopUpWei: bigint;
};

export type SweepResult =
  | { status: 'skipped' }
  | { status: 'waiting'; sweepId: string }
  | { status: 'gas-funding'; sweepId: string }
  | { status: 'broadcast'; sweepId: string; txHash: string }
  | { status: 'confirmed'; sweepId: string }
  | { status: 'failed'; sweepId: string };

type ClaimedSweep = {
  sweep: {
    id: string;
    status: DepositSweepStatus;
    gasTxHash: string | null;
    sweepTxHash: string | null;
    amountMicroUsdt: bigint;
  };
  depositAddress: {
    id: string;
    address: string;
    derivationIndex: number;
  };
};

async function claimSweep(prisma: PrismaClient, depositAddressId: string): Promise<ClaimedSweep | null> {
  return withSerializableRetry(prisma, async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DepositAddress" WHERE "id" = ${depositAddressId}::uuid FOR UPDATE`);
    const depositAddress = await tx.depositAddress.findUniqueOrThrow({ where: { id: depositAddressId } });
    const existing = await tx.depositSweep.findFirst({
      where: { depositAddressId, status: transferStatuses },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, gasTxHash: true, sweepTxHash: true, amountMicroUsdt: true },
    });
    if (existing) return { sweep: existing, depositAddress };
    if (depositAddress.sweepPendingAt === null) return null;
    const sweep = await tx.depositSweep.create({
      data: { depositAddressId, amountMicroUsdt: 0n, attempts: 1 },
      select: { id: true, status: true, gasTxHash: true, sweepTxHash: true, amountMicroUsdt: true },
    });
    return { sweep, depositAddress };
  });
}

async function markFailed(prisma: PrismaClient, sweepId: string, lastError: string): Promise<void> {
  await prisma.depositSweep.update({
    where: { id: sweepId },
    data: { status: DepositSweepStatus.FAILED, lastError, attempts: { increment: 1 } },
  });
}

async function clearDustSweep(prisma: PrismaClient, sweepId: string, depositAddressId: string): Promise<void> {
  await withSerializableRetry(prisma, async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DepositAddress" WHERE "id" = ${depositAddressId}::uuid FOR UPDATE`);
    await tx.depositAddress.updateMany({ where: { id: depositAddressId }, data: { sweepPendingAt: null } });
    await tx.depositSweep.deleteMany({
      where: { id: sweepId, status: { in: [DepositSweepStatus.PENDING, DepositSweepStatus.GAS_FUNDING] }, gasTxHash: null, sweepTxHash: null },
    });
    await tx.depositSweep.updateMany({
      where: { id: sweepId, status: DepositSweepStatus.GAS_FUNDING, gasTxHash: { not: null }, sweepTxHash: null },
      data: { status: DepositSweepStatus.FAILED, lastError: 'balance below sweep threshold after gas funding' },
    });
  });
}

function deriveDepositSigner(accountNode: HDNodeWallet, derivationIndex: number, storedAddress: string): HDNodeWallet {
  try {
    const signer = accountNode.deriveChild(derivationIndex);
    if (getAddress(signer.address) !== getAddress(storedAddress)) throw new Error('address mismatch');
    return signer;
  } catch {
    throw new Error('deposit address derivation mismatch');
  }
}

function transferRequest(
  config: SweepConfig,
  balance: bigint,
  fees: Awaited<ReturnType<ChainProvider['estimateFees']>>,
): TransactionRequest {
  return {
    to: config.usdtContractAddress,
    data: usdtInterface.encodeFunctionData('transfer', [getAddress(config.hotWalletAddress), balance]),
    chainId: config.chainId,
    ...feeFieldsWithType(fees),
  };
}

async function sweepTransfer(
  prisma: PrismaClient,
  provider: ChainProvider,
  signer: TransactionSigner,
  config: SweepConfig,
  sweepId: string,
  depositAddressId: string,
): Promise<SweepResult> {
  const currentBalance = await provider.getTokenBalance(config.usdtContractAddress, signer.address);
  if (currentBalance < BigInt(config.sweepMinMicroUsdt)) {
    await clearDustSweep(prisma, sweepId, depositAddressId);
    return { status: 'skipped' };
  }
  const fees = await provider.estimateFees();
  const withoutGas = transferRequest(config, currentBalance, fees);
  const estimatedGas = await provider.estimateGas({ ...withoutGas, from: signer.address });
  const gasLimit = calculateGasLimit(estimatedGas, config);
  const transaction: TransactionRequest = {
    ...withoutGas,
    gasLimit,
    nonce: await provider.getTransactionCount(signer.address, 'pending'),
  };
  const signedTransaction = await signer.signTransaction(transaction);
  const txHash = keccak256(signedTransaction);
  await prisma.depositSweep.update({
    where: { id: sweepId },
    data: { sweepTxHash: txHash, status: DepositSweepStatus.BROADCAST, amountMicroUsdt: currentBalance },
  });
  try {
    await provider.sendTransaction(signedTransaction);
  } catch (error) {
    if (!isKnownBroadcastError(error, txHash)) throw error;
  }
  return { status: 'broadcast', sweepId, txHash };
}

async function confirmSweep(
  prisma: PrismaClient,
  provider: ChainProvider,
  config: SweepConfig,
  sweep: ClaimedSweep['sweep'],
): Promise<SweepResult> {
  if (sweep.sweepTxHash === null) return { status: 'waiting', sweepId: sweep.id };
  const receipt = await provider.getTransactionReceipt(sweep.sweepTxHash);
  if (receipt === null) return { status: 'waiting', sweepId: sweep.id };
  if (receipt.status !== 1) {
    await markFailed(prisma, sweep.id, 'sweep transaction reverted on-chain');
    return { status: 'failed', sweepId: sweep.id };
  }
  const head = await assertChainHealthy(prisma, provider, config);
  if (head - receipt.blockNumber + 1 < config.confirmations) return { status: 'waiting', sweepId: sweep.id };
  const address = await prisma.depositSweep.findUniqueOrThrow({
    where: { id: sweep.id },
    select: { depositAddressId: true },
  });
  await withSerializableRetry(prisma, async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DepositAddress" WHERE "id" = ${address.depositAddressId}::uuid FOR UPDATE`);
    await tx.depositSweep.update({
      where: { id: sweep.id },
      data: { status: DepositSweepStatus.CONFIRMED, confirmedAt: new Date(), amountMicroUsdt: sweep.amountMicroUsdt },
    });
    await tx.depositAddress.updateMany({ where: { id: address.depositAddressId }, data: { sweepPendingAt: null } });
  });
  return { status: 'confirmed', sweepId: sweep.id };
}

async function resumeGasFunding(
  prisma: PrismaClient,
  provider: ChainProvider,
  accountNode: HDNodeWallet,
  config: SweepConfig,
  claimed: ClaimedSweep,
): Promise<SweepResult> {
  if (claimed.sweep.gasTxHash === null) return { status: 'gas-funding', sweepId: claimed.sweep.id };
  const receipt = await provider.getTransactionReceipt(claimed.sweep.gasTxHash);
  if (receipt === null) return { status: 'waiting', sweepId: claimed.sweep.id };
  if (receipt.status !== 1) {
    await markFailed(prisma, claimed.sweep.id, 'gas funding transaction reverted on-chain');
    return { status: 'failed', sweepId: claimed.sweep.id };
  }
  return sweepCurrentBalance(prisma, provider, accountNode, config, claimed);
}

async function sweepCurrentBalance(
  prisma: PrismaClient,
  provider: ChainProvider,
  accountNode: HDNodeWallet,
  config: SweepConfig,
  claimed: ClaimedSweep,
): Promise<SweepResult> {
  let signer: HDNodeWallet;
  try {
    signer = deriveDepositSigner(accountNode, claimed.depositAddress.derivationIndex, claimed.depositAddress.address);
  } catch {
    await markFailed(prisma, claimed.sweep.id, 'deposit address derivation mismatch');
    return { status: 'failed', sweepId: claimed.sweep.id };
  }
  const balance = await provider.getTokenBalance(config.usdtContractAddress, signer.address);
  if (balance < BigInt(config.sweepMinMicroUsdt)) {
    await clearDustSweep(prisma, claimed.sweep.id, claimed.depositAddress.id);
    return { status: 'skipped' };
  }
  const fees = await provider.estimateFees();
  const withoutGas = transferRequest(config, balance, fees);
  const gasLimit = calculateGasLimit(await provider.estimateGas({ ...withoutGas, from: signer.address }), config);
  const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice;
  if (maxFeePerGas === undefined) throw new Error('provider returned no usable fee estimate');
  const required = gasLimit * maxFeePerGas;
  const nativeBalance = await provider.getNativeBalance(signer.address);
  if (nativeBalance < required) {
    const shortfall = required - nativeBalance;
    if (shortfall > config.sweepMaxGasTopUpWei) {
      await markFailed(prisma, claimed.sweep.id, 'required gas top-up exceeds configured maximum');
      return { status: 'failed', sweepId: claimed.sweep.id };
    }
    await prisma.depositSweep.update({
      where: { id: claimed.sweep.id },
      data: { status: DepositSweepStatus.GAS_FUNDING, amountMicroUsdt: balance, attempts: { increment: 1 } },
    });
    return { status: 'gas-funding', sweepId: claimed.sweep.id };
  }
  return sweepTransfer(prisma, provider, signer, config, claimed.sweep.id, claimed.depositAddress.id);
}

export async function sweepDepositAddress(
  prisma: PrismaClient,
  provider: ChainProvider,
  accountNode: HDNodeWallet,
  config: SweepConfig,
  depositAddressId: string,
): Promise<SweepResult> {
  await assertChainHealthy(prisma, provider, config);
  const claimed = await claimSweep(prisma, depositAddressId);
  if (claimed === null) return { status: 'skipped' };
  try {
    if (claimed.sweep.status === DepositSweepStatus.BROADCAST) return await confirmSweep(prisma, provider, config, claimed.sweep);
    if (claimed.sweep.status === DepositSweepStatus.GAS_FUNDING) {
      return await resumeGasFunding(prisma, provider, accountNode, config, claimed);
    }
    return await sweepCurrentBalance(prisma, provider, accountNode, config, claimed);
  } catch (error) {
    const current = await prisma.depositSweep.findUnique({ where: { id: claimed.sweep.id }, select: { status: true, sweepTxHash: true } });
    if (current?.sweepTxHash === null && (current.status === DepositSweepStatus.PENDING || current.status === DepositSweepStatus.GAS_FUNDING)) {
      await markFailed(prisma, claimed.sweep.id, error instanceof Error ? error.message : 'deposit sweep failed');
    }
    throw error;
  }
}

export type GasFundingResult =
  | { status: 'skipped' }
  | { status: 'broadcast'; sweepId: string; txHash: string }
  | { status: 'ready'; sweepId: string }
  | { status: 'failed'; sweepId: string };

export async function fundSweepGas(
  prisma: PrismaClient,
  provider: ChainProvider,
  accountNode: HDNodeWallet,
  hotWalletSigner: TransactionSigner,
  config: SweepConfig,
  sweepId: string,
): Promise<GasFundingResult> {
  await assertChainHealthy(prisma, provider, config);
  const sweep = await prisma.depositSweep.findUnique({
    where: { id: sweepId },
    include: { depositAddress: true },
  });
  if (!sweep || sweep.status !== DepositSweepStatus.GAS_FUNDING || sweep.gasTxHash !== null) return { status: 'skipped' };
  let depositSigner: HDNodeWallet;
  try {
    depositSigner = deriveDepositSigner(accountNode, sweep.depositAddress.derivationIndex, sweep.depositAddress.address);
  } catch {
    await markFailed(prisma, sweep.id, 'deposit address derivation mismatch');
    return { status: 'failed', sweepId };
  }
  const balance = await provider.getTokenBalance(config.usdtContractAddress, depositSigner.address);
  if (balance < BigInt(config.sweepMinMicroUsdt)) {
    await clearDustSweep(prisma, sweep.id, sweep.depositAddressId);
    return { status: 'skipped' };
  }
  const fees = await provider.estimateFees();
  const sweepWithoutGas = transferRequest(config, balance, fees);
  const sweepGasLimit = calculateGasLimit(await provider.estimateGas({ ...sweepWithoutGas, from: depositSigner.address }), config);
  const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice;
  if (maxFeePerGas === undefined) throw new Error('provider returned no usable fee estimate');
  const required = sweepGasLimit * maxFeePerGas;
  const nativeBalance = await provider.getNativeBalance(depositSigner.address);
  if (nativeBalance >= required) {
    await prisma.depositSweep.update({ where: { id: sweep.id }, data: { status: DepositSweepStatus.PENDING, amountMicroUsdt: balance } });
    return { status: 'ready', sweepId: sweep.id };
  }
  const shortfall = required - nativeBalance;
  if (shortfall > config.sweepMaxGasTopUpWei) {
    await markFailed(prisma, sweep.id, 'required gas top-up exceeds configured maximum');
    return { status: 'failed', sweepId: sweep.id };
  }
  const topUpWithoutGas: TransactionRequest = {
    to: getAddress(depositSigner.address),
    value: shortfall,
    chainId: config.chainId,
    ...feeFieldsWithType(fees),
  };
  const topUpGasLimit = calculateGasLimit(await provider.estimateGas({ ...topUpWithoutGas, from: hotWalletSigner.address }), config);
  const requiredHotWalletBalance = shortfall + topUpGasLimit * maxFeePerGas;
  if (await provider.getNativeBalance(hotWalletSigner.address) < requiredHotWalletBalance) {
    await markFailed(prisma, sweep.id, 'hot wallet cannot cover gas top-up and transaction fee');
    return { status: 'failed', sweepId: sweep.id };
  }
  const topUp: TransactionRequest = {
    ...topUpWithoutGas,
    gasLimit: topUpGasLimit,
    nonce: await provider.getTransactionCount(hotWalletSigner.address, 'pending'),
  };
  const signedTransaction = await hotWalletSigner.signTransaction(topUp);
  const txHash = keccak256(signedTransaction);
  await prisma.depositSweep.update({ where: { id: sweep.id }, data: { gasTxHash: txHash, status: DepositSweepStatus.GAS_FUNDING } });
  try {
    await provider.sendTransaction(signedTransaction);
  } catch (error) {
    if (!isKnownBroadcastError(error, txHash)) throw error;
  }
  return { status: 'broadcast', sweepId: sweep.id, txHash };
}
