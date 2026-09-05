export type TransakEnvironment = 'staging' | 'production';

export type TransakFetch = (input: string, init?: RequestInit) => Promise<Response>;

export class TransakApiError extends Error {
  public readonly status: number;
  public readonly endpoint: 'refresh-token' | 'session';

  public constructor(endpoint: 'refresh-token' | 'session', status: number, message = 'Transak request failed') {
    super(message);
    this.name = 'TransakApiError';
    this.status = status;
    this.endpoint = endpoint;
  }
}

export type TransakClient = {
  createWidgetSession(input: {
    walletAddress: string;
    userId: string;
    amountUsdt?: string;
  }): Promise<{ url: string; expiresAt: string }>;
};

export type TransakClientOptions = {
  apiKey: string;
  apiSecret: string;
  environment: TransakEnvironment;
  referrerDomain: string;
  fetch?: TransakFetch;
  now?: () => number;
};

type AccessToken = {
  value: string;
  expiresAtMs: number;
};

function hosts(environment: TransakEnvironment): { api: string; gateway: string } {
  return environment === 'staging'
    ? { api: 'https://api-stg.transak.com', gateway: 'https://api-gateway-stg.transak.com' }
    : { api: 'https://api.transak.com', gateway: 'https://api-gateway.transak.com' };
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export function createTransakClient(options: TransakClientOptions): TransakClient {
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const { api, gateway } = hosts(options.environment);
  let token: AccessToken | undefined;

  const refreshToken = async (): Promise<AccessToken> => {
    const response = await fetcher(`${api}/partners/api/v2/refresh-token`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'api-secret': options.apiSecret,
        'x-api-key': options.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ apiKey: options.apiKey }),
    });
    const payload = await responseJson(response) as { data?: { accessToken?: unknown; expiresAt?: unknown } } | undefined;
    if (!response.ok) throw new TransakApiError('refresh-token', response.status);
    if (typeof payload?.data?.accessToken !== 'string' || typeof payload.data.expiresAt !== 'number') {
      throw new TransakApiError('refresh-token', response.status, 'Invalid Transak access token response');
    }
    token = { value: payload.data.accessToken, expiresAtMs: payload.data.expiresAt * 1000 };
    return token;
  };

  const accessToken = async (): Promise<AccessToken> => {
    if (token !== undefined && token.expiresAtMs - now() > 60_000) return token;
    return refreshToken();
  };

  const createWidgetSession = async (input: {
    walletAddress: string;
    userId: string;
    amountUsdt?: string;
  }): Promise<{ url: string; expiresAt: string }> => {
    let currentToken = await accessToken();
    const request = async (access: AccessToken) => fetcher(`${gateway}/api/v2/auth/session`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'access-token': access.value,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        widgetParams: {
          apiKey: options.apiKey,
          referrerDomain: options.referrerDomain,
          productsAvailed: 'BUY',
          cryptoCurrencyCode: 'USDT',
          network: 'polygon',
          walletAddress: input.walletAddress,
          disableWalletAddressForm: true,
          defaultFiatCurrency: 'EUR',
          partnerCustomerId: input.userId,
          ...(input.amountUsdt === undefined ? {} : { defaultCryptoAmount: Number(input.amountUsdt) }),
        },
      }),
    });
    let response = await request(currentToken);
    if (response.status === 401) {
      currentToken = await refreshToken();
      response = await request(currentToken);
    }
    const payload = await responseJson(response) as { data?: { widgetUrl?: unknown } } | undefined;
    if (!response.ok) throw new TransakApiError('session', response.status);
    if (typeof payload?.data?.widgetUrl !== 'string') throw new TransakApiError('session', response.status, 'Invalid Transak widget response');
    return {
      url: payload.data.widgetUrl,
      expiresAt: new Date(now() + 5 * 60_000).toISOString(),
    };
  };

  return { createWidgetSession };
}
