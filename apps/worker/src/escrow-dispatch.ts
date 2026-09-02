import { getAddress, Interface, keccak256, type TransactionRequest } from 'ethers';
import { EscrowSettlementStatus, EscrowUnloadStatus, PrismaClient } from '@trustme/db';
import { confirmSettlement, confirmUnload, failSettlement, failUnload, trustCouponEscrowAbi } from '@trustme/core';
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
  const buyer = await prisma.memberWallet.findFirst({ where: { userId: settlement.buyerId, isPrimary: true } });
  if (buyer === null) {
    await failSettlement(prisma, { settlementId, error: 'buyer wallet is not registered' });
    return { status: 'failed' };
  }
  try {
    await assertChainHealthy(prisma, provider, config);
    const fees = await provider.estimateFees();
    const encoded = contractInterface.encodeFunctionData('settle', [getAddress(buyer.address), settlement.amountMicroUsdt, settlement.ref]);
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
