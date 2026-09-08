import { getAddress, Interface, keccak256, type TransactionRequest } from 'ethers';
import { EscrowPermitDepositStatus, EscrowSettlementStatus, EscrowUnloadStatus, PrismaClient } from '@trustme/db';
import { confirmPermitDeposit, confirmSettlement, confirmUnload, failPermitDeposit, failSettlement, failUnload, trustCouponEscrowAbi } from '@trustme/core';
import { assertChainHealthy, type ChainHealthConfig } from './chain-health.js';
import { calculateGasLimit, feeFieldsWithType, isKnownBroadcastError } from './dispatch.js';
import type { ChainProvider, TransactionSigner } from './provider.js';

const contractInterface = new Interface(trustCouponEscrowAbi);
export type EscrowDispatchConfig = ChainHealthConfig & {
  escrowContractAddress?: string | undefined;
  escrowSettlerKey?: string | undefined;
  usdtContractAddress: string;
  chainId: number;
  confirmations: number;
  gasSafetyMultiplierBps: number;
  gasLimitCeiling: number;
  escrowMaxAttempts?: number;
};

export async function dispatchEscrowSettlement(
  prisma: PrismaClient,
  provider: ChainProvider,
  signer: TransactionSigner,
  config: EscrowDispatchConfig,
  settlementId: string,
): Promise<{ status: string; txHash?: string }> {
  if (config.escrowContractAddress === undefined || config.escrowSettlerKey === undefined) return { status: 'disabled' };
  const settlement = await prisma.escrowSettlement.findUnique({ where: { id: settlementId } });
  if (settlement === null || settlement.status !== EscrowSettlementStatus.PENDING) return { status: 'skipped' };
  if (settlement.chainTxHash !== null) return { status: 'broadcast', txHash: settlement.chainTxHash };
  if (settlement.attempts >= (config.escrowMaxAttempts ?? 5)) {
    await failSettlement(prisma, { settlementId, error: 'escrow settlement attempt limit reached' });
    return { status: 'failed' };
  }
  const payer = await prisma.memberWallet.findFirst({ where: { userId: settlement.payerId, isPrimary: true } });
  if (payer === null) {
    await failSettlement(prisma, { settlementId, error: 'payer wallet is not registered' });
    return { status: 'failed' };
  }
  try {
    await assertChainHealthy(prisma, provider, config);
    const fees = await provider.estimateFees();
    const encoded = contractInterface.encodeFunctionData('settle', [getAddress(payer.address), settlement.amountMicroUsdt, settlement.ref]);
    const base: TransactionRequest = { to: config.escrowContractAddress, data: encoded, chainId: config.chainId, nonce: await provider.getTransactionCount(signer.address, 'pending'), ...feeFieldsWithType(fees) };
    const gasLimit = calculateGasLimit(await provider.estimateGas({ ...base, from: signer.address }), config);
    const signed = await signer.signTransaction({ ...base, gasLimit });
    const txHash = keccak256(signed);
    await prisma.escrowSettlement.update({ where: { id: settlementId }, data: { chainTxHash: txHash, attempts: { increment: 1 } } });
    try { await provider.sendTransaction(signed); } catch (error) { if (!isKnownBroadcastError(error, txHash)) throw error; }
    return { status: 'broadcast', txHash };
  } catch (error) {
    await prisma.escrowSettlement.update({
      where: { id: settlementId },
      data: { attempts: { increment: 1 }, lastError: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }
}

export async function dispatchEscrowUnload(
  prisma: PrismaClient,
  provider: ChainProvider,
  signer: TransactionSigner,
  config: EscrowDispatchConfig,
  unloadId: string,
): Promise<{ status: string; txHash?: string }> {
  if (config.escrowContractAddress === undefined || config.escrowSettlerKey === undefined) return { status: 'disabled' };
  const unload = await prisma.escrowUnload.findUnique({ where: { id: unloadId } });
  if (unload === null || unload.status !== EscrowUnloadStatus.PENDING) return { status: 'skipped' };
  if (unload.chainTxHash !== null) return { status: 'broadcast', txHash: unload.chainTxHash };
  if (unload.attempts >= (config.escrowMaxAttempts ?? 5)) {
    await failUnload(prisma, { unloadId, error: 'escrow unload attempt limit reached' });
    return { status: 'failed' };
  }
  try {
    await assertChainHealthy(prisma, provider, config);
    const fees = await provider.estimateFees();
    const base: TransactionRequest = { to: config.escrowContractAddress, data: contractInterface.encodeFunctionData('unloadFor', [getAddress(unload.walletAddress), unload.amountMicroUsdt, unload.ref]), chainId: config.chainId, nonce: await provider.getTransactionCount(signer.address, 'pending'), ...feeFieldsWithType(fees) };
    const gasLimit = calculateGasLimit(await provider.estimateGas({ ...base, from: signer.address }), config);
    const signed = await signer.signTransaction({ ...base, gasLimit });
    const txHash = keccak256(signed);
    await prisma.escrowUnload.update({ where: { id: unloadId }, data: { chainTxHash: txHash, attempts: { increment: 1 } } });
    try { await provider.sendTransaction(signed); } catch (error) { if (!isKnownBroadcastError(error, txHash)) throw error; }
    return { status: 'broadcast', txHash };
  } catch (error) {
    await prisma.escrowUnload.update({
      where: { id: unloadId },
      data: { attempts: { increment: 1 }, lastError: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }
}

function revertReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const reason = message.match(/(?:reason string|reason|execution reverted)[:=]\s*['"]?([^'"\n]+)['"]?/i)?.[1];
  return reason === undefined ? message : reason;
}

function isEstimateRevert(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /revert|call_exception|execution reverted/i.test(message);
}

export async function dispatchEscrowPermitDeposit(
  prisma: PrismaClient,
  provider: ChainProvider,
  signer: TransactionSigner,
  config: EscrowDispatchConfig,
  permitDepositId: string,
): Promise<{ status: string; txHash?: string }> {
  if (config.escrowContractAddress === undefined || config.escrowSettlerKey === undefined) return { status: 'disabled' };
  const permitDeposit = await prisma.escrowPermitDeposit.findUnique({ where: { id: permitDepositId } });
  if (permitDeposit === null || permitDeposit.status !== EscrowPermitDepositStatus.PENDING) return { status: 'skipped' };
  if (permitDeposit.chainTxHash !== null) return { status: 'broadcast', txHash: permitDeposit.chainTxHash };
  if (permitDeposit.attempts >= (config.escrowMaxAttempts ?? 5)) {
    await failPermitDeposit(prisma, { permitDepositId, error: 'escrow permit deposit attempt limit reached' });
    return { status: 'failed' };
  }
  try {
    await assertChainHealthy(prisma, provider, config);
    const fees = await provider.estimateFees();
    const base: TransactionRequest = {
      to: config.escrowContractAddress,
      data: contractInterface.encodeFunctionData('depositWithPermit', [
        getAddress(permitDeposit.walletAddress),
        permitDeposit.amountMicroUsdt,
        permitDeposit.deadline,
        permitDeposit.v,
        permitDeposit.r,
        permitDeposit.s,
      ]),
      chainId: config.chainId,
      nonce: await provider.getTransactionCount(signer.address, 'pending'),
      ...feeFieldsWithType(fees),
    };
    let gasLimit;
    try {
      gasLimit = calculateGasLimit(await provider.estimateGas({ ...base, from: signer.address }), config);
    } catch (error) {
      if (isEstimateRevert(error)) {
        await failPermitDeposit(prisma, { permitDepositId, error: revertReason(error) });
        return { status: 'failed' };
      }
      throw error;
    }
    const signed = await signer.signTransaction({ ...base, gasLimit });
    const txHash = keccak256(signed);
    await prisma.escrowPermitDeposit.update({ where: { id: permitDepositId }, data: { chainTxHash: txHash, attempts: { increment: 1 } } });
    try { await provider.sendTransaction(signed); } catch (error) { if (!isKnownBroadcastError(error, txHash)) throw error; }
    return { status: 'broadcast', txHash };
  } catch (error) {
    await prisma.escrowPermitDeposit.update({
      where: { id: permitDepositId },
      data: { attempts: { increment: 1 }, lastError: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }
}

export async function confirmEscrowSettlement(prisma: PrismaClient, provider: ChainProvider, settlementId: string) {
  const row = await prisma.escrowSettlement.findUnique({ where: { id: settlementId } });
  if (row === null || row.chainTxHash === null) return { status: 'skipped' };
  const receipt = await provider.getTransactionReceipt(row.chainTxHash);
  if (receipt === null) return { status: 'waiting', txHash: row.chainTxHash };
  if (receipt.status !== 1) {
    await failSettlement(prisma, { settlementId, error: 'escrow settlement reverted on-chain' });
    return { status: 'failed', txHash: row.chainTxHash };
  }
  await confirmSettlement(prisma, { ref: row.ref, txHash: row.chainTxHash });
  return { status: 'completed', txHash: row.chainTxHash };
}

export async function confirmEscrowUnload(prisma: PrismaClient, provider: ChainProvider, unloadId: string) {
  const row = await prisma.escrowUnload.findUnique({ where: { id: unloadId } });
  if (row === null || row.chainTxHash === null) return { status: 'skipped' };
  const receipt = await provider.getTransactionReceipt(row.chainTxHash);
  if (receipt === null) return { status: 'waiting', txHash: row.chainTxHash };
  if (receipt.status !== 1) {
    await failUnload(prisma, { unloadId, error: 'escrow unload reverted on-chain' });
    return { status: 'failed', txHash: row.chainTxHash };
  }
  await confirmUnload(prisma, { ref: row.ref, txHash: row.chainTxHash });
  return { status: 'completed', txHash: row.chainTxHash };
}

export async function confirmEscrowPermitDeposit(prisma: PrismaClient, provider: ChainProvider, permitDepositId: string) {
  const row = await prisma.escrowPermitDeposit.findUnique({ where: { id: permitDepositId } });
  if (row === null || row.chainTxHash === null) return { status: 'skipped' };
  const receipt = await provider.getTransactionReceipt(row.chainTxHash);
  if (receipt === null) return { status: 'waiting', txHash: row.chainTxHash };
  if (receipt.status !== 1) {
    await failPermitDeposit(prisma, { permitDepositId, error: 'escrow permit deposit reverted on-chain' });
    return { status: 'failed', txHash: row.chainTxHash };
  }
  await confirmPermitDeposit(prisma, { permitDepositId, txHash: row.chainTxHash });
  return { status: 'completed', txHash: row.chainTxHash };
}
