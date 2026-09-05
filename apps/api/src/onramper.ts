import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto';

export type OnramperWidgetFields = {
  apiKey: string;
  mode: 'buy';
  onlyCryptos: 'usdt_polygon';
  defaultCrypto: 'usdt_polygon';
  wallets: string;
  isAddressEditable: 'false';
  defaultFiat: 'eur';
  partnerContext: string;
  defaultAmount?: string;
};

export function signOnramperWidgetUrl(input: {
  baseUrl: string;
  privateKeyPem: string;
  fields: OnramperWidgetFields;
  now?: Date;
  nonce?: string;
  expiryMinutes?: number;
}): { url: string; expiresAt: Date } {
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const nonce = input.nonce ?? randomUUID();
  const expiryMinutes = input.expiryMinutes ?? 15;
  const expiresAt = new Date(now.getTime() + expiryMinutes * 60_000);
  const sortedFields = Object.entries(input.fields)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  const canonicalQuery = new URLSearchParams(sortedFields).toString();
  const canonical = [
    'ONRAMPER-SIG-V2',
    timestamp,
    nonce,
    'GET',
    '/',
    canonicalQuery,
    '',
    createHash('sha256').update('').digest('hex'),
  ].join('\n');
  const signature = sign(null, Buffer.from(canonical), createPrivateKey(input.privateKeyPem)).toString('base64');
  const query = new URLSearchParams(sortedFields);
  query.set('sigV2', `v2:${signature}`);
  query.set('sigV2Timestamp', timestamp);
  query.set('sigV2Nonce', nonce);
  query.set('sigV2Expiry', expiresAt.toISOString());
  query.set('sigV2Fields', sortedFields.map(([key]) => key).join(','));
  return {
    url: `${input.baseUrl.replace(/\/+$/, '')}/?${query.toString()}`,
    expiresAt,
  };
}
