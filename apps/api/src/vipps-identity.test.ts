import { describe, expect, it } from 'vitest';
import { createVippsIdentityClient } from './vipps-identity.js';

const options = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  subscriptionKey: 'subscription-key',
  msn: 'merchant-serial',
  apiBase: 'https://api.vipps.test',
  scope: 'openid name phoneNumber email',
  redirectUri: 'https://api.example.test/v1/me/identity/vipps/callback',
};

describe('Vipps identity client', () => {
  it('builds a PKCE authorization URL from discovery metadata', async () => {
    const fetcher = async () => new Response(JSON.stringify({
      issuer: 'https://issuer.test/',
      authorization_endpoint: 'https://issuer.test/oauth2/auth',
      token_endpoint: 'https://issuer.test/oauth2/token',
      userinfo_endpoint: 'https://issuer.test/userinfo',
      jwks_uri: 'https://issuer.test/jwks',
    }), { status: 200 });
    const client = createVippsIdentityClient(options, fetcher);
    const url = new URL(await client.authorizationUrl({ state: 'state', nonce: 'nonce', codeChallenge: 'challenge' }));
    expect(url.origin + url.pathname).toBe('https://issuer.test/oauth2/auth');
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(options.redirectUri);
    expect(url.searchParams.get('scope')).toBe(options.scope);
    expect(url.searchParams.get('state')).toBe('state');
    expect(url.searchParams.get('nonce')).toBe('nonce');
    expect(url.searchParams.get('code_challenge')).toBe('challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('exchanges a code with the confidential client headers and form', async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init === undefined ? { input } : { input, init });
      if (requests.length === 1) return new Response(JSON.stringify({
        issuer: 'https://issuer.test/',
        authorization_endpoint: 'https://issuer.test/oauth2/auth',
        token_endpoint: 'https://issuer.test/oauth2/token',
        userinfo_endpoint: 'https://issuer.test/userinfo',
        jwks_uri: 'https://issuer.test/jwks',
      }));
      return new Response(JSON.stringify({ id_token: 'id-token', access_token: 'access-token' }));
    };
    const client = createVippsIdentityClient(options, fetcher);
    await client.authorizationUrl({ state: 'state', nonce: 'nonce', codeChallenge: 'challenge' });
    expect(await client.exchangeCode({ code: 'auth-code', codeVerifier: 'verifier' })).toEqual({ idToken: 'id-token', accessToken: 'access-token' });
    const tokenRequest = requests[1]!;
    expect(String(tokenRequest.input)).toBe('https://issuer.test/oauth2/token');
    expect(tokenRequest.init?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`,
      'Ocp-Apim-Subscription-Key': 'subscription-key',
      'Merchant-Serial-Number': 'merchant-serial',
    });
    expect(new URLSearchParams(tokenRequest.init?.body as string)).toEqual(new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'auth-code',
      redirect_uri: options.redirectUri,
      code_verifier: 'verifier',
    }));
  });

  it('maps userinfo claims and uses a bearer token', async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init === undefined ? { input } : { input, init });
      if (requests.length === 1) return new Response(JSON.stringify({ issuer: 'https://issuer.test/', authorization_endpoint: 'https://issuer.test/auth', token_endpoint: 'https://issuer.test/token', userinfo_endpoint: 'https://issuer.test/userinfo', jwks_uri: 'https://issuer.test/jwks' }));
      return new Response(JSON.stringify({ sub: 'vipps-sub', name: 'Vipps User', given_name: 'Vipps', family_name: 'User', phone_number: '4791234567', email: 'user@example.com', email_verified: true, nin: '12345678901' }));
    };
    const claims = await createVippsIdentityClient(options, fetcher).userInfo('access-token');
    expect(claims).toEqual({
      sub: 'vipps-sub',
      name: 'Vipps User',
      givenName: 'Vipps',
      familyName: 'User',
      phoneNumber: '4791234567',
      email: 'user@example.com',
      emailVerified: true,
      nin: '12345678901',
    });
    expect(requests[1]?.init?.headers).toMatchObject({
      Authorization: 'Bearer access-token',
      'Ocp-Apim-Subscription-Key': 'subscription-key',
      'Merchant-Serial-Number': 'merchant-serial',
    });
  });
});
