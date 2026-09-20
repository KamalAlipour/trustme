import { HttpError } from './http-error.js';

export type HumanVerifier = (token: string, remoteIp: string | undefined) => Promise<boolean>;

type TurnstileResponse = { success?: boolean };

export function turnstileVerifier(secretKey: string): HumanVerifier {
  return async (token, remoteIp) => {
    const body = new URLSearchParams({
      secret: secretKey,
      response: token,
      ...(remoteIp === undefined ? {} : { remoteip: remoteIp }),
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      });
      const result = await response.json() as TurnstileResponse;
      return result.success === true;
    } catch (error) {
      console.warn('[human-verification] Turnstile verification failed', error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      clearTimeout(timeout);
    }
  };
}

export const humanVerificationFailed = new HttpError(403, 'human_verification_failed');
