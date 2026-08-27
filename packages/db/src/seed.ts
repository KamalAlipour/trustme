import { prisma, AccountType, Asset } from './index.js';

const accounts = [
  { type: AccountType.SYSTEM_COUPON_ISSUANCE, asset: Asset.COUPON },
  { type: AccountType.SYSTEM_VAULT_USDT, asset: Asset.USDT },
  { type: AccountType.SYSTEM_WITHDRAWAL_PENDING, asset: Asset.USDT },
  { type: AccountType.SYSTEM_FEE_COLLECTION, asset: Asset.USDT },
  { type: AccountType.EXTERNAL_ONCHAIN, asset: Asset.USDT },
  { type: AccountType.GUARANTEE_LOCK, asset: Asset.COUPON },
] as const;

const settings = [
  ['WITHDRAWAL_BASE_FEE_BPS', '100'],
  ['MIN_WITHDRAWAL_USDT', '1'],
  ['AUTO_APPROVAL_LIMIT_USDT', '1000'],
  ['WITHDRAWAL_COOLDOWN_HOURS', '168'],
] as const;

for (const account of accounts) {
  const existing = await prisma.ledgerAccount.findFirst({ where: { type: account.type, userId: null, asset: account.asset } });
  if (!existing) await prisma.ledgerAccount.create({ data: account });
}
for (const [key, value] of settings) {
  await prisma.systemSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
}
await prisma.$disconnect();
