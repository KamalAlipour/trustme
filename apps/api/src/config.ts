import { z } from 'zod';

const integer = z.coerce.number().int().positive();

export const apiConfigSchema = z.object({
  databaseUrl: z.string().min(1),
  redisUrl: z.string().min(1),
  apiServiceToken: z.string().min(1),
  depositXpub: z.string().min(1),
  port: integer.default(3000),
  bodyLimit: z.string().default('32kb'),
  rateLimitWindowMs: integer.default(60_000),
  rateLimitMax: integer.default(60),
});

export type ApiConfig = z.infer<typeof apiConfigSchema>;

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return apiConfigSchema.parse({
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    apiServiceToken: env.API_SERVICE_TOKEN,
    depositXpub: env.DEPOSIT_XPUB,
    port: env.API_PORT,
    bodyLimit: env.API_BODY_LIMIT,
    rateLimitWindowMs: env.API_RATE_LIMIT_WINDOW_MS,
    rateLimitMax: env.API_RATE_LIMIT_MAX,
  });
}
