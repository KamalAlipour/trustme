import { execFile } from 'node:child_process';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import bcrypt from 'bcryptjs';
import {
  Contract,
  ContractFactory,
  HDNodeWallet,
  JsonRpcProvider,
  type InterfaceAbi,
} from 'ethers';
import solc from 'solc';
import { PrismaClient } from '@trustme/db';
import { readSolvency, trustCouponEscrowAbi } from '@trustme/core';
import {
  confirmEscrowSettlement,
  confirmEscrowUnload,
  createEthersProvider,
  createWalletSigner,
  dispatchEscrowSettlement,
  dispatchEscrowUnload,
  ingestEscrowOnce,
  type EscrowDispatchConfig,
  type EscrowIngestConfig,
} from '../apps/worker/src/index.js';

const execFileAsync = promisify(execFile);
const root = path.resolve(new URL('..', import.meta.url).pathname);
const apiUrl = process.env.ESCROW_API_URL ?? 'http://127.0.0.1:3121';
const rpcUrl = process.env.LOCAL_ESCROW_RPC_URL ?? 'http://127.0.0.1:8545';
const databaseUrl = process.env.DATABASE_URL;
// Anvil's well-known test-only development mnemonic; never use on a public chain.
const anvilMnemonic = 'test test test test test test test test test test test junk';
const microDeposit = 50_000_000n;
const microSettlement = 12_340_000n;
const localChainId = 31_337n;

type JsonObject = Record<string, unknown>;
type HttpResult = { status: number; body: unknown };

const asObject = (value: unknown, label: string): JsonObject => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} was not an object`);
  return value as JsonObject;
};

const asString = (value: unknown, label: string): string => {
  if (typeof value !== 'string') throw new Error(`${label} was not a string`);
  return value;
};

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const pass = (label: string, detail?: string): void => {
  process.stdout.write(`PASS ${label}${detail === undefined ? '' : `: ${detail}`}\n`);
};

function localUrl(value: string, label: string): void {
  const parsed = new URL(value);
  assert(parsed.protocol === 'http:' || parsed.protocol === 'https:', `${label} must be an HTTP(S) URL`);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname), `${label} must point to localhost`);
}

function localDatabase(value: string): void {
  const parsed = new URL(value);
  assert(parsed.protocol === 'postgresql:' || parsed.protocol === 'postgres:', 'DATABASE_URL must be a PostgreSQL URL');
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname), 'DATABASE_URL must point to localhost');
}

async function request(route: string, options: RequestInit = {}): Promise<HttpResult> {
  const response = await fetch(`${apiUrl}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let body: unknown = null;
  if (text !== '') {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  return { status: response.status, body };
}

function auth(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    value = await read();
  }
  assert(predicate(value), `${label} timed out`);
  return value;
}

function accountFromIndex(rpc: JsonRpcProvider, index: number): HDNodeWallet {
  return HDNodeWallet.fromPhrase(anvilMnemonic, undefined, `m/44'/60'/0'/0/${index}`).connect(rpc);
}

async function compileMockToken(): Promise<{ abi: InterfaceAbi; bytecode: string }> {
  const source = await readFile(path.join(root, 'contracts', 'MockUsdt.sol'), 'utf8');
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { 'MockUsdt.sol': { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  }))) as {
    errors?: Array<{ severity: string; formattedMessage: string }>;
    contracts: Record<string, Record<string, { abi: InterfaceAbi; evm: { bytecode: { object: string } } }>>;
  };
  const fatal = (output.errors ?? []).filter((error) => error.severity === 'error');
  assert(fatal.length === 0, fatal.map((error) => error.formattedMessage).join('\n'));
  const compiled = output.contracts['MockUsdt.sol']?.MockUsdt;
  assert(compiled !== undefined && compiled.evm.bytecode.object !== '', 'MockUsdt compilation produced no bytecode');
  return { abi: compiled.abi, bytecode: `0x${compiled.evm.bytecode.object}` };
}

async function deployEscrow(tokenAddress: string, deployer: HDNodeWallet, settlerAddress: string, vaultAddress: string): Promise<string> {
  const packagePath = path.join(root, 'scripts', 'package.json');
  let createdPackageMarker = false;
  try {
    await access(packagePath);
  } catch {
    await writeFile(packagePath, '{\n  "type": "module"\n}\n', 'utf8');
    createdPackageMarker = true;
  }
  try {
    const { stdout } = await execFileAsync('npx', ['tsx', 'scripts/deploy-escrow.ts'], {
      cwd: root,
      env: {
        ...process.env,
        POLYGON_RPC_URL: rpcUrl,
        ESCROW_DEPLOYER_KEY: deployer.privateKey,
        USDT_CONTRACT_ADDRESS: tokenAddress,
        ESCROW_VAULT_ADDRESS: vaultAddress,
        ESCROW_SETTLER_ADDRESS: settlerAddress,
      },
      maxBuffer: 1_000_000,
    });
    const match = stdout.match(/TrustCouponEscrow deployed at (0x[0-9a-fA-F]{40})/);
    assert(match?.[1] !== undefined, 'deployment script did not report a contract address');
    return match[1];
  } finally {
    if (createdPackageMarker) await rm(packagePath);
  }
}

async function escrowState(prisma: PrismaClient, userId: string): Promise<{ locked: bigint; reserved: bigint; dust: bigint; coupons: bigint }> {
  const [balance, user, account] = await Promise.all([
    prisma.escrowBalance.findUnique({ where: { userId } }),
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { dustMicroUsdt: true } }),
    prisma.ledgerAccount.findFirstOrThrow({ where: { userId, type: 'USER_COUPON', asset: 'COUPON' }, select: { balance: true } }),
  ]);
  return {
    locked: balance?.lockedMicroUsdt ?? 0n,
    reserved: balance?.reservedMicroUsdt ?? 0n,
    dust: user.dustMicroUsdt,
    coupons: account.balance,
  };
}

async function chainBalances(token: Contract, escrowAddress: string, vaultAddress: string, buyerAddress: string): Promise<{ escrow: bigint; vault: bigint; buyer: bigint }> {
  const [escrow, vault, buyer] = await Promise.all([
    token.getFunction('balanceOf')(escrowAddress),
    token.getFunction('balanceOf')(vaultAddress),
    token.getFunction('balanceOf')(buyerAddress),
  ]);
  return { escrow: BigInt(escrow), vault: BigInt(vault), buyer: BigInt(buyer) };
}

async function dispatchAndConfirm(
  prisma: PrismaClient,
  rpc: JsonRpcProvider,
  dispatchConfig: EscrowDispatchConfig,
  settlerKey: string,
  settlementId: string,
): Promise<void> {
  const provider = createEthersProvider(rpc);
  const signer = createWalletSigner(settlerKey, rpc);
  await rpc.send('evm_mine', []);
  const result = await dispatchEscrowSettlement(prisma, provider, signer, dispatchConfig, settlementId);
  assert(result.status === 'broadcast' && result.txHash !== undefined, `settlement dispatch returned ${result.status}`);
  const txHash = result.txHash;
  await waitFor(() => prisma.escrowSettlement.findUniqueOrThrow({ where: { id: settlementId } }), (row) => row.chainTxHash === txHash, 'settlement broadcast');
  await waitFor(async () => rpc.getTransactionReceipt(txHash), (receipt) => receipt !== null, 'settlement receipt');
  await confirmEscrowSettlement(prisma, provider, settlementId);
  await waitFor(() => prisma.escrowSettlement.findUniqueOrThrow({ where: { id: settlementId } }), (row) => row.status === 'CONFIRMED', 'settlement confirmation');
}

async function dispatchUnloadAndConfirm(
  prisma: PrismaClient,
  rpc: JsonRpcProvider,
  dispatchConfig: EscrowDispatchConfig,
  settlerKey: string,
  unloadId: string,
): Promise<void> {
  const provider = createEthersProvider(rpc);
  const signer = createWalletSigner(settlerKey, rpc);
  await rpc.send('evm_mine', []);
  const result = await dispatchEscrowUnload(prisma, provider, signer, dispatchConfig, unloadId);
  assert(result.status === 'broadcast' && result.txHash !== undefined, `unload dispatch returned ${result.status}`);
  const txHash = result.txHash;
  await waitFor(() => prisma.escrowUnload.findUniqueOrThrow({ where: { id: unloadId } }), (row) => row.chainTxHash === txHash, 'unload broadcast');
  await waitFor(async () => rpc.getTransactionReceipt(txHash), (receipt) => receipt !== null, 'unload receipt');
  await confirmEscrowUnload(prisma, provider, unloadId);
  await waitFor(() => prisma.escrowUnload.findUniqueOrThrow({ where: { id: unloadId } }), (row) => row.status === 'CONFIRMED', 'unload confirmation');
}

async function main(): Promise<void> {
  assert(databaseUrl !== undefined, 'DATABASE_URL is required');
  localDatabase(databaseUrl);
  localUrl(rpcUrl, 'LOCAL_ESCROW_RPC_URL');
  localUrl(apiUrl, 'ESCROW_API_URL');
  const rpc = new JsonRpcProvider(rpcUrl);
  assert((await rpc.getNetwork()).chainId === localChainId, 'RPC chain must be local Anvil chain 31337');
  pass('local safety guards', 'chainId=31337 and localhost URLs');

  const deployer = accountFromIndex(rpc, 0);
  const settler = accountFromIndex(rpc, 1);
  const buyer = accountFromIndex(rpc, 8);
  const merchant = accountFromIndex(rpc, 9);
  const vault = accountFromIndex(rpc, 4);
  const mock = await compileMockToken();
  const token = await new ContractFactory(mock.abi, mock.bytecode, deployer).deploy();
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  const escrowAddress = await deployEscrow(tokenAddress, deployer, settler.address, vault.address);
  const escrow = new Contract(escrowAddress, trustCouponEscrowAbi, buyer);
  assert((await escrow.getFunction('settler')()) === settler.address, 'deployed settler did not read back correctly');
  pass('contracts deployed and settler configured');

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-10);
    const buyerRegistration = await request('/v1/auth/register', { method: 'POST', body: JSON.stringify({ phone: `+1555${suffix.slice(-7)}`, pin: '2468', displayName: 'Local E2E Buyer' }) });
    const merchantRegistration = await request('/v1/auth/register', { method: 'POST', body: JSON.stringify({ phone: `+1666${suffix.slice(-7)}`, pin: '2468', displayName: 'Local E2E Merchant' }) });
    assert(buyerRegistration.status === 201 && merchantRegistration.status === 201, 'member registration failed');
    const buyerMember = asObject(buyerRegistration.body, 'buyer registration');
    const merchantMember = asObject(merchantRegistration.body, 'merchant registration');
    const buyerTokens = asObject(buyerMember.tokens, 'buyer tokens');
    const merchantTokens = asObject(merchantMember.tokens, 'merchant tokens');
    const buyerToken = asString(buyerTokens.accessToken, 'buyer access token');
    const merchantToken = asString(merchantTokens.accessToken, 'merchant access token');
    const buyerData = asObject(buyerMember.member, 'buyer member');
    const merchantData = asObject(merchantMember.member, 'merchant member');
    const buyerId = asString(buyerData.id, 'buyer id');
    const merchantId = asString(merchantData.id, 'merchant id');
    const buyerBarcode = asString(buyerData.barcodeId, 'buyer barcode');
    const setup = await Promise.all([
      request('/v1/member/security/biometric', { method: 'POST', headers: auth(buyerToken), body: JSON.stringify({ pin: '2468', biometricEnrolled: false }) }),
      request('/v1/member/security/biometric', { method: 'POST', headers: auth(merchantToken), body: JSON.stringify({ pin: '2468', biometricEnrolled: false }) }),
    ]);
    assert(setup.every((result) => result.status === 200), 'security setup failed');
    const wallets = await Promise.all([
      request('/v1/me/wallets', { method: 'POST', headers: auth(buyerToken), body: JSON.stringify({ address: buyer.address, kind: 'IN_APP' }) }),
      request('/v1/me/wallets', { method: 'POST', headers: auth(merchantToken), body: JSON.stringify({ address: merchant.address, kind: 'IN_APP' }) }),
    ]);
    assert(wallets.every((result) => result.status === 201), 'wallet registration failed');
    pass('members and wallets registered');

    const tokenContract = new Contract(tokenAddress, mock.abi, buyer);
    const mintReceipt = await (await tokenContract.getFunction('mint')(buyer.address, microDeposit)).wait();
    assert(mintReceipt !== null, 'mint transaction was not mined');
    const approvalReceipt = await (await tokenContract.getFunction('approve')(escrowAddress, microDeposit)).wait();
    assert(approvalReceipt !== null, 'approval transaction was not mined');
    const depositReceipt = await (await escrow.getFunction('deposit')(microDeposit)).wait();
    assert(depositReceipt !== null, 'deposit transaction was not mined');
    const escrowIngestConfig: EscrowIngestConfig = {
      escrowContractAddress: escrowAddress,
      chainStartBlock: 0,
      confirmations: 0,
      maxBlockRange: 2_000,
      ingestChunksPerTick: 20,
      reorgRewindBlocks: 64,
    };
    const depositEvent = await waitFor(async () => {
      const row = await prisma.escrowChainEvent.findFirst({ where: { txHash: depositReceipt!.hash, amountMicroUsdt: microDeposit } });
      if (row !== null) return row;
      await prisma.chainCursor.upsert({ where: { id: 2 }, update: { nextBlock: BigInt(depositReceipt!.blockNumber), lastBlockHash: null }, create: { id: 2, nextBlock: BigInt(depositReceipt!.blockNumber) } });
      await ingestEscrowOnce(prisma, createEthersProvider(rpc), escrowIngestConfig);
      return null;
    }, (row): row is NonNullable<typeof row> => row !== null, 'deposit ingest');
    assert(depositEvent !== null, 'deposit event was not persisted');
    const depositedState = await escrowState(prisma, buyerId);
    const depositedApi = await request('/v1/me/escrow', { headers: auth(buyerToken) });
    const depositedApiBody = asObject(depositedApi.body, 'deposit escrow response');
    assert(depositedApi.status === 200 && depositedApiBody.lockedMicroUsdt === microDeposit.toString() && depositedApiBody.reservedMicroUsdt === '0' && depositedApiBody.availableMicroUsdt === microDeposit.toString(), 'deposit API escrow balance mismatch');
    assert(depositedState.locked === microDeposit && depositedState.reserved === 0n, 'deposit escrow balance mismatch');
    pass('deposit ingested', `locked=${depositedState.locked} available=${depositedState.locked - depositedState.reserved}`);

    const beforeDuplicate = await escrowState(prisma, buyerId);
    await prisma.chainCursor.update({ where: { id: 2 }, data: { nextBlock: depositEvent.blockNumber, lastBlockHash: null } });
    const duplicateRun = await ingestEscrowOnce(prisma, createEthersProvider(rpc), escrowIngestConfig);
    const afterDuplicate = await escrowState(prisma, buyerId);
    const duplicateCount = await prisma.escrowChainEvent.count({ where: { txHash: depositEvent.txHash, logIndex: depositEvent.logIndex } });
    assert(afterDuplicate.locked === beforeDuplicate.locked && duplicateCount === 1, 'duplicate deposit ingest credited twice');
    pass('duplicate deposit ingest ignored', `processed=${duplicateRun.processed} matchingEvents=${duplicateCount} locked=${afterDuplicate.locked}`);

    const payCode = await request('/v1/me/escrow/pay-codes', { method: 'POST', headers: auth(buyerToken), body: JSON.stringify({ code: '4826', maxAmount: '20.00', pin: '2468' }) });
    assert(payCode.status === 201, 'pay-code creation failed');
    const merchantBefore = await escrowState(prisma, merchantId);
    const settlement = await request('/v1/me/escrow/settlements', { method: 'POST', headers: auth(merchantToken), body: JSON.stringify({ buyerBarcodeId: buyerBarcode, code: '4826', amount: '12.34', idempotencyKey: `local-e2e-${suffix}`, pin: '2468' }) });
    assert(settlement.status === 201, 'settlement creation failed');
    const settlementData = asObject(settlement.body, 'settlement response');
    const settlementId = asString(settlementData.id, 'settlement id');
    const immediate = await escrowState(prisma, buyerId);
    const merchantAfter = await escrowState(prisma, merchantId);
    const immediateApi = await request('/v1/me/escrow', { headers: auth(buyerToken) });
    const immediateApiBody = asObject(immediateApi.body, 'settlement escrow response');
    assert(immediate.locked === microDeposit && immediate.reserved === microSettlement, 'settlement reservation mismatch');
    assert(immediateApi.status === 200 && immediateApiBody.reservedMicroUsdt === microSettlement.toString(), 'settlement API reservation mismatch');
    const settlementRow = await prisma.escrowSettlement.findUniqueOrThrow({ where: { id: settlementId } });
    assert(settlementRow.status === 'PENDING' && merchantAfter.dust === merchantBefore.dust, 'settlement immediate state mismatch');
    assert(merchantAfter.coupons === 1_234n && merchantAfter.dust - merchantBefore.dust === 0n, 'merchant coupon or dust mismatch');
    pass('settlement created', `status=${settlementRow.status} reserved=${immediate.reserved} merchantCoupons=${merchantAfter.coupons} dustDelta=0`);

    const dispatchConfig: EscrowDispatchConfig = {
      escrowContractAddress: escrowAddress,
      escrowSettlerKey: settler.privateKey,
      usdtContractAddress: tokenAddress,
      chainId: 31_337,
      confirmations: 0,
      gasSafetyMultiplierBps: 12_500,
      gasLimitCeiling: 200_000,
      escrowMaxAttempts: 5,
      chainMaxBlockAgeSeconds: 3_600,
    };
    await dispatchAndConfirm(prisma, rpc, dispatchConfig, settler.privateKey, settlementId);
    const afterSettlement = await escrowState(prisma, buyerId);
    const settlementBalances = await chainBalances(tokenContract, escrowAddress, vault.address, buyer.address);
    assert(afterSettlement.locked === microDeposit - microSettlement && afterSettlement.reserved === 0n, 'post-settlement escrow balance mismatch');
    assert(settlementBalances.escrow === microDeposit - microSettlement && settlementBalances.vault === microSettlement && settlementBalances.buyer === 0n, 'post-settlement chain balance mismatch');
    pass('settlement dispatched', `escrow=${settlementBalances.escrow} vault=${settlementBalances.vault} locked=${afterSettlement.locked} reserved=${afterSettlement.reserved}`);

    const replay = await request('/v1/me/escrow/settlements', { method: 'POST', headers: auth(merchantToken), body: JSON.stringify({ buyerBarcodeId: buyerBarcode, code: '4826', amount: '12.34', idempotencyKey: `local-e2e-${suffix}`, pin: '2468' }) });
    const replayData = asObject(replay.body, 'settlement replay');
    assert(replay.status === 201 && replayData.id === settlementId, 'settlement idempotency replay created a new settlement');
    assert(await prisma.escrowSettlement.count({ where: { id: settlementId } }) === 1, 'settlement replay row count mismatch');
    pass('settlement idempotency replay reused existing row', `http=${replay.status}`);

    const wrongCode = await request('/v1/me/escrow/pay-codes', { method: 'POST', headers: auth(buyerToken), body: JSON.stringify({ code: '1357', maxAmount: '1.00', pin: '2468' }) });
    assert(wrongCode.status === 201, 'wrong-code pay-code creation failed');
    const wrongCodeId = asString(asObject(wrongCode.body, 'wrong-code response').id, 'wrong-code id');
    const wrongResponses = await Promise.all(['0000', '1111', '2222'].map((code) => request('/v1/me/escrow/settlements', { method: 'POST', headers: auth(merchantToken), body: JSON.stringify({ buyerBarcodeId: buyerBarcode, code, amount: '1.00', idempotencyKey: `wrong-${suffix}-${code}`, pin: '2468' }) })));
    assert(wrongResponses[0]?.status === 400 && wrongResponses[1]?.status === 400 && wrongResponses[2]?.status === 400, 'wrong-code responses were not rejected');
    const wrongRow = await prisma.payCode.findUniqueOrThrow({ where: { id: wrongCodeId } });
    assert(wrongRow.status === 'CANCELLED' && wrongRow.wrongAttempts === 3, 'wrong-code pay code was not cancelled');
    pass('three wrong codes cancelled pay code', `statuses=${wrongResponses.map((result) => result.status).join(',')}`);

    const expired = await request('/v1/me/escrow/pay-codes', { method: 'POST', headers: auth(buyerToken), body: JSON.stringify({ code: '2468', maxAmount: '1.00', pin: '2468' }) });
    assert(expired.status === 201, 'expired-code pay-code creation failed');
    const expiredId = asString(asObject(expired.body, 'expired-code response').id, 'expired-code id');
    await prisma.payCode.update({ where: { id: expiredId }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    const expiredResponse = await request('/v1/me/escrow/settlements', { method: 'POST', headers: auth(merchantToken), body: JSON.stringify({ buyerBarcodeId: buyerBarcode, code: '2468', amount: '1.00', idempotencyKey: `expired-${suffix}`, pin: '2468' }) });
    assert(expiredResponse.status === 400 && asObject(expiredResponse.body, 'expired response').error === 'pay code has expired', 'expired pay code was not rejected');
    pass('expired pay code rejected', `http=${expiredResponse.status}`);

    // Test-only fixture: the API correctly refuses a max amount above availability,
    // so create this one pay code directly to reach settlement's escrow-limit guard.
    const overCodeHash = await bcrypt.hash('8642', 12);
    const overCode = await prisma.payCode.create({ data: { buyerId, codeHash: overCodeHash, maxAmountMicroUsdt: 50_000_000n, expiresAt: new Date(Date.now() + 300_000) } });
    const overBefore = await escrowState(prisma, buyerId);
    const overResponse = await request('/v1/me/escrow/settlements', { method: 'POST', headers: auth(merchantToken), body: JSON.stringify({ buyerBarcodeId: buyerBarcode, code: '8642', amount: '40.00', idempotencyKey: `over-${suffix}`, pin: '2468' }) });
    const overAfter = await escrowState(prisma, buyerId);
    assert(overResponse.status === 400 && asObject(overResponse.body, 'over-available response').error === 'settlement exceeds available escrow', 'over-available settlement was not rejected');
    assert(overAfter.locked === overBefore.locked && overAfter.reserved === overBefore.reserved, 'over-available settlement changed escrow balance');
    await prisma.payCode.update({ where: { id: overCode.id }, data: { status: 'CANCELLED' } });
    pass('over-available settlement rejected', `http=${overResponse.status} lockedUnchanged=${overAfter.locked}`);

    const unload = await request('/v1/me/escrow/unloads', { method: 'POST', headers: auth(buyerToken), body: JSON.stringify({ amount: '37.66', pin: '2468' }) });
    assert(unload.status === 201, 'unload creation failed');
    const unloadBody = asObject(unload.body, 'unload response');
    assert(unloadBody.status === 'PENDING', 'unload did not start pending');
    const unloadId = asString(unloadBody.id, 'unload id');
    const reservedForUnload = await escrowState(prisma, buyerId);
    assert(reservedForUnload.locked === 37_660_000n && reservedForUnload.reserved === 37_660_000n, 'unload reservation mismatch');
    await dispatchUnloadAndConfirm(prisma, rpc, dispatchConfig, settler.privateKey, unloadId);
    const finalBalances = await chainBalances(tokenContract, escrowAddress, vault.address, buyer.address);
    const finalState = await escrowState(prisma, buyerId);
    const finalApi = await request('/v1/me/escrow', { headers: auth(buyerToken) });
    const finalApiBody = asObject(finalApi.body, 'final escrow response');
    assert(finalBalances.escrow === 0n && finalBalances.vault === microSettlement && finalBalances.buyer === 37_660_000n, 'final chain balances mismatch');
    assert(finalState.locked === 0n && finalState.reserved === 0n, 'final escrow balance mismatch');
    assert(finalApi.status === 200 && finalApiBody.lockedMicroUsdt === '0' && finalApiBody.reservedMicroUsdt === '0' && finalApiBody.availableMicroUsdt === '0', 'final API escrow balance mismatch');
    pass('full unload confirmed', `escrow=${finalBalances.escrow} vault=${finalBalances.vault} buyer=${finalBalances.buyer} locked=${finalState.locked} reserved=${finalState.reserved}`);

    const solvency = await readSolvency(prisma);
    const escrowLocked = (await prisma.escrowBalance.aggregate({ _sum: { lockedMicroUsdt: true } }))._sum.lockedMicroUsdt ?? 0n;
    const [entries, accounts] = await Promise.all([
      prisma.ledgerEntry.findMany({ select: { transactionId: true, asset: true, amount: true, fromAccountId: true, toAccountId: true } }),
      prisma.ledgerAccount.findMany({ select: { id: true, asset: true, balance: true } }),
    ]);
    const transactionAssets = new Set<string>();
    const accountFlows = new Map<string, { debit: bigint; credit: bigint }>();
    for (const entry of entries) {
      assert(entry.amount > 0n, `non-positive ledger entry in ${entry.transactionId}`);
      transactionAssets.add(`${entry.transactionId}:${entry.asset}`);
      const from = accountFlows.get(entry.fromAccountId) ?? { debit: 0n, credit: 0n };
      from.debit += entry.amount;
      accountFlows.set(entry.fromAccountId, from);
      const to = accountFlows.get(entry.toAccountId) ?? { debit: 0n, credit: 0n };
      to.credit += entry.amount;
      accountFlows.set(entry.toAccountId, to);
    }
    for (const account of accounts) {
      const flow = accountFlows.get(account.id) ?? { debit: 0n, credit: 0n };
      assert(account.balance === flow.credit - flow.debit, `ledger balance mismatch for ${account.asset} account`);
    }
    assert(transactionAssets.size > 0 && solvency.isSolvent && solvency.custodyMicroUsdt >= solvency.obligationsMicroUsdt && escrowLocked === 0n, 'final solvency invariant failed');
    pass('ledger and solvency invariants', `transactions=${new Set(entries.map((entry) => entry.transactionId)).size} entries=${entries.length} custody=${solvency.custodyMicroUsdt} obligations=${solvency.obligationsMicroUsdt} surplus=${solvency.surplusMicroUsdt} escrowLocked=${escrowLocked}`);
    process.stdout.write('SUMMARY escrow-local-e2e: PASS\n');
  } finally {
    await prisma.$disconnect();
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`FAIL escrow-local-e2e: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
