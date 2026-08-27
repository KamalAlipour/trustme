import { z } from 'zod';

const configSchema = z.object({
  trustmeApiUrl: z.string().url(),
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
});

export const config = configSchema.parse({
  trustmeApiUrl: process.env.TRUSTME_API_URL,
  nodeEnv: process.env.NODE_ENV,
});

export const secureCookies = config.nodeEnv === 'production';
