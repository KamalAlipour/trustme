import { z } from 'zod';
import { evmAddressSchema } from '@trustme/core';

const integer = z.coerce.number().int().positive();
const boolean = z.preprocess((value) => {
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return value;
}, z.boolean());

export const apiConfigSchema = z.object({
  databaseUrl: z.string().min(1),
  redisUrl: z.string().min(1),
  apiServiceToken: z.string().min(1),
  depositXpub: z.string().min(1),
  adminJwtSecret: z.string().min(32),
  adminJwtTtlSeconds: integer.default(3600),
  memberJwtSecret: z.string().min(32),
  memberJwtTtlSeconds: integer.default(900),
  memberRefreshTtlDays: integer.default(60),
  emailDelivery: z.enum(['none', 'log', 'smtp']).default('none'),
  requireEmailVerification: boolean.default(false),
  pinResetQuarantineHours: integer.default(72),
  smtpHost: z.string().optional(),
  smtpPort: integer.optional(),
  smtpUser: z.string().optional(),
  smtpPassword: z.string().optional(),
  smtpFrom: z.string().optional(),
  nodeEnv: z.string().default('development'),
  polygonRpcUrl: z.string().url(),
  usdtContractAddress: evmAddressSchema,
  escrowContractAddress: evmAddressSchema.optional(),
  escrowChainId: integer.default(137),
  walletConnectProjectId: z.string().optional(),
  web3AuthClientId: z.string().optional(),
  hotWalletAddress: evmAddressSchema,
  bindHost: z.string().default('127.0.0.1'),
  port: integer.default(3000),
  bodyLimit: z.string().default('32kb'),
  rateLimitWindowMs: integer.default(60_000),
  rateLimitMax: integer.default(60),
  failoverMarkerPath: z.string().default('/etc/trustme/FAILED_OVER'),
  mediaStorageDir: z.string().default('/var/lib/trustme/media'),
  googleOAuthClientIds: z.string().optional().transform((value) => value?.split(',').map((id) => id.trim()).filter(Boolean)),
  appleOAuthAudiences: z.string().optional().transform((value) => value?.split(',').map((id) => id.trim()).filter(Boolean)),
  shahkarApiToken: z.string().min(1).optional(),
  shahkarBaseUrl: z.string().url().default('https://s.api.ir/api/sw1/ShahkarLite'),
  identityHashPepper: z.string().min(32).optional(),
  allowedOrigins: z.string().default('').transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean)),
});

export type ApiConfig = z.infer<typeof apiConfigSchema>;

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const config = apiConfigSchema.parse({
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    apiServiceToken: env.API_SERVICE_TOKEN,
    depositXpub: env.DEPOSIT_XPUB,
    adminJwtSecret: env.ADMIN_JWT_SECRET,
    adminJwtTtlSeconds: env.ADMIN_JWT_TTL_SECONDS,
    memberJwtSecret: env.MEMBER_JWT_SECRET,
    memberJwtTtlSeconds: env.MEMBER_JWT_TTL_SECONDS,
    memberRefreshTtlDays: env.MEMBER_REFRESH_TTL_DAYS,
    emailDelivery: env.EMAIL_DELIVERY,
    requireEmailVerification: env.REQUIRE_EMAIL_VERIFICATION,
    pinResetQuarantineHours: env.PIN_RESET_QUARANTINE_HOURS,
    smtpHost: env.SMTP_HOST,
    smtpPort: env.SMTP_PORT,
    smtpUser: env.SMTP_USER,
    smtpPassword: env.SMTP_PASSWORD,
    smtpFrom: env.SMTP_FROM,
    nodeEnv: env.NODE_ENV,
    polygonRpcUrl: env.POLYGON_RPC_URL,
    usdtContractAddress: env.USDT_CONTRACT_ADDRESS,
    escrowContractAddress: env.ESCROW_CONTRACT_ADDRESS || undefined,
    escrowChainId: env.ESCROW_CHAIN_ID,
    walletConnectProjectId: env.WALLETCONNECT_PROJECT_ID || undefined,
    web3AuthClientId: env.WEB3AUTH_CLIENT_ID || undefined,
    hotWalletAddress: env.HOT_WALLET_ADDRESS,
    bindHost: env.API_BIND_HOST,
    port: env.API_PORT,
    bodyLimit: env.API_BODY_LIMIT,
    rateLimitWindowMs: env.API_RATE_LIMIT_WINDOW_MS,
    rateLimitMax: env.API_RATE_LIMIT_MAX,
    failoverMarkerPath: env.FAILOVER_MARKER_PATH,
    mediaStorageDir: env.MEDIA_STORAGE_DIR,
    googleOAuthClientIds: env.GOOGLE_OAUTH_CLIENT_IDS,
    appleOAuthAudiences: env.APPLE_OAUTH_AUDIENCES,
    shahkarApiToken: env.SHAHKAR_API_TOKEN || undefined,
    shahkarBaseUrl: env.SHAHKAR_BASE_URL,
    identityHashPepper: env.IDENTITY_HASH_PEPPER || undefined,
    allowedOrigins: env.API_ALLOWED_ORIGINS,
  });
  if (config.nodeEnv === 'production' && config.emailDelivery === 'log') {
    throw new Error('EMAIL_DELIVERY=log is not allowed in production');
  }
  if (config.emailDelivery === 'smtp' && (
    config.smtpHost === undefined ||
    config.smtpPort === undefined ||
    config.smtpUser === undefined ||
    config.smtpPassword === undefined ||
    config.smtpFrom === undefined
  )) {
    throw new Error('SMTP settings are required when EMAIL_DELIVERY=smtp');
  }
  return config;
}
