import { z } from 'zod';

const configSchema = z.object({
  trustmeApiUrl: z.string().url(),
  adminGoogleClientId: z.string().optional(),
  publicUrl: z.string().url().optional(),
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
});

export const config = configSchema.parse({
  trustmeApiUrl: process.env.TRUSTME_API_URL,
  adminGoogleClientId: process.env.ADMIN_GOOGLE_CLIENT_ID || undefined,
  publicUrl: process.env.ADMIN_PUBLIC_URL || undefined,
  nodeEnv: process.env.NODE_ENV,
});

export const secureCookies = config.nodeEnv === 'production';
