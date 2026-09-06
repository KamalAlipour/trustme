import { createRemoteJWKSet, jwtVerify } from 'jose';

export type VippsIdentityClaims = {
  sub: string;
  name: string | null;
  givenName: string | null;
  familyName: string | null;
  phoneNumber: string | null;
  email: string | null;
  emailVerified: boolean;
  nin: string | null;
};

export type VippsIdentityClient = {
  authorizationUrl(input: { state: string; nonce: string; codeChallenge: string }): Promise<string>;
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<{ idToken: string; accessToken: string }>;
  verifyIdToken(idToken: string, nonce: string): Promise<VippsIdentityClaims>;
  userInfo(accessToken: string): Promise<VippsIdentityClaims>;
};

type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
};

export type VippsIdentityClientOptions = {
  clientId: string;
  clientSecret: string;
  subscriptionKey: string;
  msn: string;
  apiBase: string;
  scope: string;
  redirectUri: string;
};

function endpoint(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}${path}`;
}

function fallbackDiscovery(apiBase: string): Discovery {
  return {
    issuer: endpoint(apiBase, '/access-management-1.0/access/'),
    authorization_endpoint: endpoint(apiBase, '/access-management-1.0/access/oauth2/auth'),
    token_endpoint: endpoint(apiBase, '/access-management-1.0/access/oauth2/token'),
    userinfo_endpoint: endpoint(apiBase, '/vipps-userinfo-api/userinfo'),
    jwks_uri: endpoint(apiBase, '/access-management-1.0/access/.well-known/jwks.json'),
  };
}

function claimString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function claimsFrom(payload: Record<string, unknown>): VippsIdentityClaims {
  return {
    sub: claimString(payload, 'sub') ?? '',
    name: claimString(payload, 'name'),
    givenName: claimString(payload, 'given_name'),
    familyName: claimString(payload, 'family_name'),
    phoneNumber: claimString(payload, 'phone_number'),
    email: claimString(payload, 'email'),
    emailVerified: payload.email_verified === true,
    nin: claimString(payload, 'nin'),
  };
}

export function createVippsIdentityClient(
  options: VippsIdentityClientOptions,
  fetcher: typeof fetch = fetch,
): VippsIdentityClient {
  let discoveryPromise: Promise<Discovery> | null = null;
  let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  const discovery = async (): Promise<Discovery> => {
    if (discoveryPromise !== null) return discoveryPromise;
    discoveryPromise = (async () => {
      try {
        const response = await fetcher(endpoint(options.apiBase, '/access-management-1.0/access/.well-known/openid-configuration'));
        if (!response.ok) throw new Error(`Vipps discovery failed with ${response.status}`);
        const body = await response.json() as Partial<Discovery>;
        if (
          typeof body.issuer !== 'string' ||
          typeof body.authorization_endpoint !== 'string' ||
          typeof body.token_endpoint !== 'string' ||
          typeof body.userinfo_endpoint !== 'string' ||
          typeof body.jwks_uri !== 'string'
        ) throw new Error('Vipps discovery response is invalid');
        return body as Discovery;
      } catch {
        return fallbackDiscovery(options.apiBase);
      }
    })();
    return discoveryPromise;
  };
  const headers = {
    'Ocp-Apim-Subscription-Key': options.subscriptionKey,
    'Merchant-Serial-Number': options.msn,
  };
  return {
    async authorizationUrl(input) {
      const metadata = await discovery();
      const url = new URL(metadata.authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: options.clientId,
        redirect_uri: options.redirectUri,
        scope: options.scope,
        state: input.state,
        nonce: input.nonce,
        code_challenge: input.codeChallenge,
        code_challenge_method: 'S256',
      }).toString();
      return url.toString();
    },
    async exchangeCode(input) {
      const metadata = await discovery();
      const basic = Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64');
      const response = await fetcher(metadata.token_endpoint, {
        method: 'POST',
        headers: {
          ...headers,
          Authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: input.code,
          redirect_uri: options.redirectUri,
          code_verifier: input.codeVerifier,
        }),
      });
      const body = await response.json() as { id_token?: string; access_token?: string };
      if (!response.ok || typeof body.id_token !== 'string' || typeof body.access_token !== 'string') {
        throw new Error(`Vipps token exchange failed with ${response.status}`);
      }
      return { idToken: body.id_token, accessToken: body.access_token };
    },
    async verifyIdToken(idToken, nonce) {
      const metadata = await discovery();
      jwks ??= createRemoteJWKSet(new URL(metadata.jwks_uri));
      const result = await jwtVerify(idToken, jwks, { issuer: metadata.issuer, audience: options.clientId });
      if (result.payload.nonce !== nonce) throw new Error('Vipps ID token nonce mismatch');
      const claims = claimsFrom(result.payload as Record<string, unknown>);
      if (claims.sub.length === 0) throw new Error('Vipps ID token subject is missing');
      return claims;
    },
    async userInfo(accessToken) {
      const metadata = await discovery();
      const response = await fetcher(metadata.userinfo_endpoint, {
        headers: { ...headers, Authorization: `Bearer ${accessToken}` },
      });
      const body = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(`Vipps userinfo failed with ${response.status}`);
      const claims = claimsFrom(body);
      if (claims.sub.length === 0) throw new Error('Vipps userinfo subject is missing');
      return claims;
    },
  };
}
