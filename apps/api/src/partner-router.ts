import express, { type Request } from 'express';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { AccountType, ApiKeyScope, Asset, EscrowStatus, PartnerDepositStatus, PrismaClient } from '@trustme/db';
import {
  createEscrowHold,
  decodeTransfer,
  DomainError,
  generateBarcodeId,
  microUsdtFromCouponAmount,
  networkAverageRateBps,
  postDeposit,
  releaseEscrow,
  cancelEscrow,
  withSerializableRetry,
} from '@trustme/core';
import { publicReservesPayload } from './public-router.js';
import { requireApiKey, type ApiKeyRequest } from './partner-auth.js';
import type { UserProvisioningConfig } from './user-provisioning.js';
import { createUserWithAccounts, isBarcodeUniqueViolation } from './user-provisioning.js';

export type ChainReader = {
  getTransactionReceipt(txHash: string): Promise<{
    status: number | null;
    blockNumber: number;
    logs: { address: string; topics: string[]; data: string; index: number }[];
  } | null>;
  getBlockNumber(): Promise<number>;
};

type PartnerRouterDeps = {
  provisioning: UserProvisioningConfig;
  chain: ChainReader;
  confirmations: number;
  usdtContractAddress: string;
  secretEncryptionKey?: string;
};

const buyerBodySchema = z.object({ externalRef: z.string().min(1).max(128), displayName: z.string().max(64).optional() }).strict();
const depositBodySchema = z.object({ buyerId: z.string().uuid(), txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).strict();
const checkoutBodySchema = z.object({
  buyerId: z.string().uuid(),
  sellerBarcodeId: z.string().min(1),
  amountCoupons: z.string().refine((value) => { try { microUsdtFromCouponAmount(value); return true; } catch { return false; } }),
  externalRef: z.string().min(1).max(128),
  expiresInSeconds: z.coerce.number().int().min(60).max(3600).default(900),
}).strict();
const captureBodySchema = z.object({ checkoutId: z.string().uuid(), otp: z.string().regex(/^\d{4}$/) }).strict();
const checkoutIdBodySchema = z.object({ checkoutId: z.string().uuid() }).strict();
function partnerId(request: Request): string {
  const value = (request as ApiKeyRequest).partnerUserId;
  if (value === undefined) throw new DomainError('partner_not_linked');
  return value;
}
async function couponAccount(prisma: PrismaClient, userId: string) {
  return prisma.ledgerAccount.findFirstOrThrow({ where: { userId, type: AccountType.USER_COUPON, asset: Asset.COUPON } });
}
async function escrowAccount(prisma: PrismaClient, userId: string) {
  return prisma.ledgerAccount.findFirstOrThrow({ where: { userId, type: AccountType.ESCROW, asset: Asset.COUPON } });
}
async function buyerFor(prisma: PrismaClient, partnerUserId: string, id: string) {
  return prisma.partnerBuyer.findFirst({ where: { id, partnerUserId }, include: { user: { include: { depositAddresses: true } } } });
}
function buyerPayload(buyer: { id: string; user: { barcodeId: string; depositAddresses: { address: string }[] } }, balance: bigint) {
  return { buyerId: buyer.id, barcodeId: buyer.user.barcodeId, depositAddress: buyer.user.depositAddresses[0]?.address ?? null, balanceCoupons: balance.toString() };
}
export function createPartnerRouter(prisma: PrismaClient, deps: PartnerRouterDeps): express.Router {
  const router = express.Router();
  const auth = (scope: ApiKeyScope) => deps.secretEncryptionKey === undefined
    ? requireApiKey(prisma, [scope])
    : requireApiKey(prisma, [scope], deps.secretEncryptionKey);
  router.get('/market-average', auth(ApiKeyScope.READ_MARKET_AVERAGE), async (_request, response, next) => {
    try { response.json({ networkAverageBps: await prisma.$transaction((tx) => networkAverageRateBps(tx)) }); } catch (error) { next(error); }
  });
  router.get('/reserves', auth(ApiKeyScope.READ_RESERVES), async (_request, response, next) => {
    try { response.json(await publicReservesPayload(prisma)); } catch (error) { next(error); }
  });

  router.post('/buyers', auth(ApiKeyScope.PARTNER_BUYERS), async (request, response, next) => {
    try {
      const body = buyerBodySchema.parse(request.body);
      const partnerUserId = partnerId(request);
      const existing = await prisma.partnerBuyer.findUnique({ where: { partnerUserId_externalRef: { partnerUserId, externalRef: body.externalRef } }, include: { user: { include: { depositAddresses: true } } } });
      if (existing) { response.json(buyerPayload(existing, (await couponAccount(prisma, existing.userId)).balance)); return; }
      let createdUser: { id: string } | undefined;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          createdUser = await withSerializableRetry(prisma, async (tx) => {
            const user = await createUserWithAccounts(tx, deps.provisioning, { barcodeId: generateBarcodeId(), ...(body.displayName === undefined ? {} : { displayName: body.displayName }), isDemo: false });
            await tx.user.update({ where: { id: user.id }, data: { marketerId: partnerUserId } });
            await tx.partnerBuyer.create({ data: { partnerUserId, userId: user.id, externalRef: body.externalRef } });
            return user;
          });
          break;
        } catch (error) {
          if (!isBarcodeUniqueViolation(error) || attempt === 4) throw error;
        }
      }
      if (!createdUser) throw new Error('buyer provisioning failed');
      const buyer = await prisma.partnerBuyer.findUniqueOrThrow({ where: { userId: createdUser.id }, include: { user: { include: { depositAddresses: true } } } });
      response.status(201).json(buyerPayload(buyer, 0n));
    } catch (error) { next(error); }
  });
  router.get('/buyers/:id', auth(ApiKeyScope.PARTNER_BUYERS), async (request, response, next) => {
    try {
      const buyer = await buyerFor(prisma, partnerId(request), String(request.params.id));
      if (!buyer) { response.status(404).json({ error: 'buyer_not_found' }); return; }
      response.json(buyerPayload(buyer, (await couponAccount(prisma, buyer.userId)).balance));
    } catch (error) { next(error); }
  });

  router.post('/webhooks/usdt-deposit', auth(ApiKeyScope.PARTNER_DEPOSITS), async (request, response, next) => {
    try {
      const body = depositBodySchema.parse(request.body);
      const partnerUserId = partnerId(request);
      const buyer = await buyerFor(prisma, partnerUserId, body.buyerId);
      if (!buyer) { response.status(404).json({ error: 'buyer_not_found' }); return; }
      let notice = await prisma.partnerDepositNotice.upsert({
        where: { partnerUserId_txHash: { partnerUserId, txHash: body.txHash } },
        create: { partnerUserId, buyerUserId: buyer.userId, txHash: body.txHash },
        update: {},
      });
      const prior = await prisma.transaction.findMany({ where: { userId: buyer.userId, txHash: body.txHash }, orderBy: { createdAt: 'asc' } });
      if (prior.length > 0) {
        const balance = await couponAccount(prisma, buyer.userId);
        response.json({ status: 'credited', amountMicroUsdt: prior.reduce((sum, tx) => sum + tx.amountMicroUsdt, 0n).toString(), amountCoupons: prior.reduce((sum, tx) => sum + tx.amountCoupons, 0n).toString(), transactionIds: prior.map((tx) => tx.id), balanceCoupons: balance.balance.toString() });
        return;
      }
      let receipt;
      try { receipt = await deps.chain.getTransactionReceipt(body.txHash); } catch { response.status(503).json({ error: 'chain_unavailable' }); return; }
      if (receipt === null) { response.status(202).json({ status: 'pending', reason: 'not_found' }); return; }
      if (receipt.status !== 1) {
        notice = await prisma.partnerDepositNotice.update({ where: { id: notice.id }, data: { status: PartnerDepositStatus.REJECTED, reason: 'tx_failed' } });
        response.json({ status: 'rejected', reason: notice.reason }); return;
      }
      let head: number;
      try { head = await deps.chain.getBlockNumber(); } catch { response.status(503).json({ error: 'chain_unavailable' }); return; }
      const confirmations = head - receipt.blockNumber + 1;
      if (confirmations < deps.confirmations) { response.status(202).json({ status: 'pending', confirmations: String(confirmations), required: String(deps.confirmations) }); return; }
      const destination = buyer.user.depositAddresses[0]?.address.toLowerCase();
      if (destination === undefined) throw new DomainError('buyer deposit address is unavailable');
      const matches = receipt.logs
        .filter((log) => log.address.toLowerCase() === deps.usdtContractAddress.toLowerCase())
        .map((log) => ({ log, transfer: decodeTransfer(log) }))
        .filter((item): item is { log: typeof receipt.logs[number]; transfer: { to: string; amount: bigint } } => item.transfer !== null && item.transfer.amount > 0n && item.transfer.to.toLowerCase() === destination);
      if (matches.length === 0) {
        notice = await prisma.partnerDepositNotice.update({ where: { id: notice.id }, data: { status: PartnerDepositStatus.REJECTED, reason: 'no_transfer_to_buyer' } });
        response.json({ status: 'rejected', reason: notice.reason }); return;
      }
      const external = await prisma.ledgerAccount.findFirstOrThrow({ where: { type: AccountType.EXTERNAL_ONCHAIN, asset: Asset.USDT, userId: null } });
      const vault = await prisma.ledgerAccount.findFirstOrThrow({ where: { type: AccountType.SYSTEM_VAULT_USDT, asset: Asset.USDT, userId: null } });
      const issuance = await prisma.ledgerAccount.findFirstOrThrow({ where: { type: AccountType.SYSTEM_COUPON_ISSUANCE, asset: Asset.COUPON, userId: null } });
      const userAccount = await couponAccount(prisma, buyer.userId);
      const transactions = [];
      for (const item of matches) {
        transactions.push(await postDeposit(prisma, { externalRef: `deposit:${body.txHash}:${item.log.index}`, userId: buyer.userId, userCouponAccountId: userAccount.id, externalOnchainAccountId: external.id, vaultAccountId: vault.id, issuanceAccountId: issuance.id, amountMicroUsdt: item.transfer.amount, txHash: body.txHash }));
        await prisma.depositAddress.updateMany({ where: { userId: buyer.userId, sweepPendingAt: null }, data: { sweepPendingAt: new Date() } });
      }
      const amountMicroUsdt = matches.reduce((sum, item) => sum + item.transfer.amount, 0n);
      await prisma.partnerDepositNotice.update({ where: { id: notice.id }, data: { status: PartnerDepositStatus.CREDITED, amountMicroUsdt, reason: null } });
      const balance = await couponAccount(prisma, buyer.userId);
      response.json({ status: 'credited', amountMicroUsdt: amountMicroUsdt.toString(), amountCoupons: matches.reduce((sum, item) => sum + item.transfer.amount / 10_000n, 0n).toString(), transactionIds: transactions.map((tx) => tx.id), balanceCoupons: balance.balance.toString() });
    } catch (error) { next(error); }
  });
  router.get('/webhooks/usdt-deposit/:txHash', auth(ApiKeyScope.PARTNER_DEPOSITS), async (request, response, next) => {
    try {
      const notice = await prisma.partnerDepositNotice.findUnique({ where: { partnerUserId_txHash: { partnerUserId: partnerId(request), txHash: String(request.params.txHash) } } });
      if (!notice) { response.status(404).json({ error: 'deposit_notice_not_found' }); return; }
      const transactions = await prisma.transaction.findMany({ where: { userId: notice.buyerUserId, txHash: notice.txHash } });
      response.json({ ...notice, amountMicroUsdt: notice.amountMicroUsdt?.toString() ?? null, transactions: transactions.map((tx) => ({ id: tx.id, amountMicroUsdt: tx.amountMicroUsdt.toString(), amountCoupons: tx.amountCoupons.toString(), status: tx.status })) });
    } catch (error) { next(error); }
  });

  router.post('/checkout/initiate', auth(ApiKeyScope.PARTNER_CHECKOUT), async (request, response, next) => {
    try {
      const body = checkoutBodySchema.parse(request.body);
      const partnerUserId = partnerId(request);
      const existing = await prisma.partnerCheckout.findUnique({ where: { partnerUserId_externalRef: { partnerUserId, externalRef: body.externalRef } }, include: { escrowHold: true, seller: true } });
      if (existing) { response.json({ checkoutId: existing.id, status: existing.escrowHold.status, otp: null, replayed: true, amountCoupons: existing.escrowHold.amountCoupons.toString(), expiresAt: existing.escrowHold.expiresAt, sellerBarcodeId: existing.seller.barcodeId }); return; }
      const buyer = await buyerFor(prisma, partnerUserId, body.buyerId);
      if (!buyer) { response.status(404).json({ error: 'buyer_not_found' }); return; }
      const seller = await prisma.user.findUnique({ where: { barcodeId: body.sellerBarcodeId } });
      if (!seller || seller.isDemo || seller.id === buyer.userId) { response.status(404).json({ error: 'seller_not_found' }); return; }
      const otp = randomInt(0, 10000).toString().padStart(4, '0');
      const hold = await createEscrowHold(prisma, { senderId: buyer.userId, recipientId: seller.id, senderAccountId: (await couponAccount(prisma, buyer.userId)).id, escrowAccountId: (await escrowAccount(prisma, buyer.userId)).id, amountCoupons: microUsdtFromCouponAmount(body.amountCoupons) / 10_000n, code: otp, expiresAt: new Date(Date.now() + body.expiresInSeconds * 1000), externalRef: `partner:checkout:${partnerUserId}:${body.externalRef}` });
      const checkout = await prisma.partnerCheckout.create({ data: { partnerUserId, buyerUserId: buyer.userId, sellerUserId: seller.id, escrowHoldId: hold.id, externalRef: body.externalRef } });
      response.status(201).json({ checkoutId: checkout.id, status: hold.status, otp, amountCoupons: hold.amountCoupons.toString(), expiresAt: hold.expiresAt, sellerBarcodeId: seller.barcodeId });
    } catch (error) {
      if (error instanceof DomainError && /balance|negative/.test(error.message)) { response.status(400).json({ error: 'insufficient_balance' }); return; }
      next(error);
    }
  });
  router.post('/checkout/capture', auth(ApiKeyScope.PARTNER_CHECKOUT), async (request, response, next) => {
    try {
      const body = captureBodySchema.parse(request.body);
      const checkout = await prisma.partnerCheckout.findFirst({ where: { id: body.checkoutId, partnerUserId: partnerId(request) }, include: { escrowHold: true, seller: true } });
      if (!checkout) { response.status(404).json({ error: 'checkout_not_found' }); return; }
      if (checkout.escrowHold.status === EscrowStatus.RELEASED) {
        const settled = checkout.escrowHold.releaseTransactionId === null ? null : await prisma.transaction.findUnique({ where: { id: checkout.escrowHold.releaseTransactionId } });
        response.json({ checkoutId: checkout.id, status: 'RELEASED', settledAt: settled?.createdAt ?? null }); return;
      }
      try {
        const released = await releaseEscrow(prisma, { holdId: checkout.escrowHoldId, recipientAccountId: (await couponAccount(prisma, checkout.sellerUserId)).id, code: body.otp });
        if (released === null) throw new DomainError('escrow is not active');
        response.json({ checkoutId: checkout.id, status: released.status, amountCoupons: released.amountCoupons.toString(), sellerBarcodeId: checkout.seller.barcodeId });
      } catch (error) {
        if (error instanceof DomainError && error.message === 'invalid escrow code') { const hold = await prisma.escrowHold.findUniqueOrThrow({ where: { id: checkout.escrowHoldId } }); response.status(400).json({ error: 'invalid_otp', attemptsRemaining: Math.max(0, 5 - hold.wrongAttempts) }); return; }
        if (error instanceof DomainError && error.message === 'escrow locked') { response.status(423).json({ error: 'otp_locked' }); return; }
        if (error instanceof DomainError && error.message === 'escrow has expired') { response.status(410).json({ error: 'expired' }); return; }
        if (error instanceof DomainError && error.message === 'escrow is not active') { response.status(409).json({ error: 'not_active' }); return; }
        throw error;
      }
    } catch (error) { next(error); }
  });
  router.post('/checkout/cancel', auth(ApiKeyScope.PARTNER_CHECKOUT), async (request, response, next) => {
    try {
      const body = checkoutIdBodySchema.parse(request.body);
      const checkout = await prisma.partnerCheckout.findFirst({ where: { id: body.checkoutId, partnerUserId: partnerId(request) } });
      if (!checkout) { response.status(404).json({ error: 'checkout_not_found' }); return; }
      const cancelled = await cancelEscrow(prisma, { holdId: checkout.escrowHoldId, senderAccountId: (await couponAccount(prisma, checkout.buyerUserId)).id });
      response.json({ checkoutId: checkout.id, status: cancelled.status });
    } catch (error) { next(error); }
  });
  router.get('/checkout/:id', auth(ApiKeyScope.PARTNER_CHECKOUT), async (request, response, next) => {
    try {
      const checkout = await prisma.partnerCheckout.findFirst({ where: { id: String(request.params.id), partnerUserId: partnerId(request) }, include: { escrowHold: true, seller: true } });
      if (!checkout) { response.status(404).json({ error: 'checkout_not_found' }); return; }
      response.json({ checkoutId: checkout.id, status: checkout.escrowHold.status, amountCoupons: checkout.escrowHold.amountCoupons.toString(), expiresAt: checkout.escrowHold.expiresAt, sellerBarcodeId: checkout.seller.barcodeId });
    } catch (error) { next(error); }
  });
  return router;
}
