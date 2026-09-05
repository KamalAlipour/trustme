# TrustMe Partner API

The partner treasury is a real TrustMe member. An administrator issues a
scoped bearer key and one-time HMAC secret linked to that treasury. Store the
secret only on a partner server; never put it in a browser or mobile client.

Production is `https://api-trustme.komasi.as`; test with an admin-issued key
against a staging database.

## Authentication

Send `Authorization: Bearer tck_...`, `X-TC-Timestamp` (Unix seconds), and
`X-TC-Signature` for partner keys. The signature is lowercase hexadecimal
HMAC-SHA256 over:

```text
timestamp\nMETHOD\noriginalUrl\nsha256hex(rawBody)
```

For a GET, `rawBody` is empty. Timestamps older or newer than five minutes are
rejected. The secret is returned only once by the admin API.

Node.js:

```js
import crypto from 'node:crypto';
const timestamp = Math.floor(Date.now() / 1000).toString();
const body = JSON.stringify(payload);
const message = `${timestamp}\nPOST\n/api/v1/checkout/initiate\n${crypto.createHash('sha256').update(body).digest('hex')}`;
const signature = crypto.createHmac('sha256', process.env.TRUSTME_PARTNER_SECRET).update(message).digest('hex');
```

PHP:

```php
$timestamp = (string) time();
$body = json_encode($payload, JSON_UNESCAPED_SLASHES);
$message = $timestamp . "\nPOST\n/api/v1/checkout/initiate\n" . hash('sha256', $body);
$signature = hash_hmac('sha256', $message, getenv('TRUSTME_PARTNER_SECRET'));
```

## Flow

1. `POST /api/v1/buyers` creates an idempotent temporary buyer.
2. The buyer pays USDT to the returned Polygon deposit address.
3. `POST /api/v1/webhooks/usdt-deposit` notifies TrustMe. The chain receipt,
   contract, Transfer log, destination, and twelve confirmations are
   authoritative. `1 USDT = 100 coupons`.
4. `POST /api/v1/checkout/initiate` locks coupons and returns a four-digit OTP.
5. The seller enters the OTP and the partner calls capture. Settlement is
   recorded in the coupon ledger. When enabled, the seller's marketing fee is
   split one-third to treasury, one-third to the buyer-marketer partner, and
   one-third to the seller-marketer; missing marketer shares return to
   treasury.

## Endpoints

### Buyers

`POST /api/v1/buyers`

```json
{"externalRef":"order-123","displayName":"Foreign buyer"}
```

Returns `201` with `buyerId`, `barcodeId`, `depositAddress`, and
`balanceCoupons`. Repeating the same partner `externalRef` returns `200`.

`GET /api/v1/buyers/{id}` returns those fields and the current balance.

### Deposits

`POST /api/v1/webhooks/usdt-deposit`

```json
{"buyerId":"uuid","txHash":"0x...64 hex characters..."}
```

Returns `202` while the receipt is missing or under-confirmed, `200` with
`status:"credited"` and transaction IDs after verification, or `200` rejected
with `tx_failed` / `no_transfer_to_buyer`.

`GET /api/v1/webhooks/usdt-deposit/{txHash}` returns the partner-specific
notice and credited transactions.

### Checkout

`POST /api/v1/checkout/initiate`

```json
{"buyerId":"uuid","sellerBarcodeId":"TCSELLER123","amountCoupons":"500","externalRef":"order-123","expiresInSeconds":900}
```

Returns `201` with `checkoutId`, `status:"ACTIVE"`, `otp`, `amountCoupons`,
`expiresAt`, and `sellerBarcodeId`. Replays return `200`, `otp:null`, and
`replayed:true`.

`POST /api/v1/checkout/capture`

```json
{"checkoutId":"uuid","otp":"0123"}
```

Returns `RELEASED`; wrong OTP returns `invalid_otp` and remaining attempts,
five wrong attempts return `otp_locked`, and expiration returns `expired`.

`POST /api/v1/checkout/cancel` accepts `{"checkoutId":"uuid"}` and returns
the resulting status. `GET /api/v1/checkout/{id}` returns status, amount,
expiry, and seller barcode.

## Errors and idempotency

`401` means `signature_required`, `stale_timestamp`, `invalid_signature`, or
`unauthorized`; `403` means `insufficient_scope` or `partner_not_linked`;
`404` means the resource is not owned by the partner; `400` includes
`insufficient_balance` and invalid input; `409` means an inactive checkout;
`410` means expired; `423` means OTP locked; `503` means
`chain_unavailable`.

Buyer creation is idempotent by `(partner, externalRef)`, deposits by
transaction hash and log index, and checkout initiation by
`(partner, externalRef)`. OTPs are four digits, expire with the checkout, and
lock after five wrong attempts.

## Handover details

### Key lifecycle and signing

Create a real, non-demo treasury member before issuing partner credentials.
The admin response returns `rawKey` and `rawSecret` once. Store them in a
server-side secret manager. To rotate, issue a new key, deploy the new secret,
verify a signed request, then revoke the old key. Revoked and expired keys
cannot be used, and TrustMe cannot recover a raw secret after creation.

The signed `originalUrl` is the path plus query string exactly as sent,
without scheme, host, or `baseUrl`. The signed body is the exact bytes sent.
For GET, hash the empty string. The timestamp is Unix seconds and must be
within ±300 seconds.

```js
const method = 'POST';
const originalUrl = '/api/v1/checkout/initiate?channel=web';
const body = JSON.stringify({ buyerId, sellerBarcodeId: 'TCSELLER123', amountCoupons: '500', externalRef: 'checkout-123', expiresInSeconds: 900 });
const timestamp = Math.floor(Date.now() / 1000).toString();
const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
const canonical = `${timestamp}\n${method}\n${originalUrl}\n${bodyHash}`;
const signature = crypto.createHmac('sha256', process.env.TRUSTME_PARTNER_SECRET).update(canonical).digest('hex');
```

```php
$body = json_encode(['buyerId' => $buyerId, 'sellerBarcodeId' => 'TCSELLER123',
  'amountCoupons' => '500', 'externalRef' => 'checkout-123',
  'expiresInSeconds' => 900], JSON_UNESCAPED_SLASHES);
$timestamp = (string) time();
$originalUrl = '/api/v1/checkout/initiate?channel=web';
$canonical = $timestamp . "\nPOST\n" . $originalUrl . "\n" . hash('sha256', $body);
$signature = hash_hmac('sha256', $canonical, getenv('TRUSTME_PARTNER_SECRET'));
```

### Exact endpoint JSON

```json
POST /api/v1/buyers
{"externalRef":"order-buyer-123","displayName":"Foreign Buyer"}
201 {"buyerId":"uuid","barcodeId":"TC12345678","depositAddress":"0x...","balanceCoupons":"0"}

GET /api/v1/buyers/{buyerId}
200 {"buyerId":"uuid","barcodeId":"TC12345678","depositAddress":"0x...","balanceCoupons":"500"}
```

```json
POST /api/v1/webhooks/usdt-deposit
{"buyerId":"uuid","txHash":"0x1111111111111111111111111111111111111111111111111111111111111111"}
202 {"status":"pending","reason":"not_found"}
202 {"status":"pending","confirmations":7,"required":12}
200 {"status":"credited","amountMicroUsdt":"5000000","amountCoupons":"500","transactionIds":["uuid"],"balanceCoupons":"500"}
200 {"status":"rejected","reason":"tx_failed"}
200 {"status":"rejected","reason":"no_transfer_to_buyer"}
```

```json
GET /api/v1/webhooks/usdt-deposit/{txHash}
200 {"id":"uuid","partnerUserId":"uuid","buyerUserId":"uuid","txHash":"0x...","status":"CREDITED","reason":null,"amountMicroUsdt":"5000000","createdAt":"2026-09-10T12:00:00.000Z","updatedAt":"2026-09-10T12:01:00.000Z","transactions":[{"id":"uuid","amountMicroUsdt":"5000000","amountCoupons":"500","status":"CONFIRMED"}]}
```

```json
POST /api/v1/checkout/initiate
{"buyerId":"uuid","sellerBarcodeId":"TCSELLER123","amountCoupons":"500","externalRef":"checkout-123","expiresInSeconds":900}
201 {"checkoutId":"uuid","status":"ACTIVE","otp":"0427","amountCoupons":"500","expiresAt":"2026-09-10T12:15:00.000Z","sellerBarcodeId":"TCSELLER123"}
200 {"checkoutId":"uuid","status":"ACTIVE","otp":null,"replayed":true,"amountCoupons":"500","expiresAt":"2026-09-10T12:15:00.000Z","sellerBarcodeId":"TCSELLER123"}
```

```json
POST /api/v1/checkout/capture
{"checkoutId":"uuid","otp":"0427"}
200 {"checkoutId":"uuid","status":"RELEASED","amountCoupons":"500","sellerBarcodeId":"TCSELLER123"}
400 {"error":"invalid_otp","attemptsRemaining":4}

POST /api/v1/checkout/cancel
{"checkoutId":"uuid"}
200 {"checkoutId":"uuid","status":"CANCELLED"}

GET /api/v1/checkout/{checkoutId}
200 {"checkoutId":"uuid","status":"ACTIVE","amountCoupons":"500","expiresAt":"2026-09-10T12:15:00.000Z","sellerBarcodeId":"TCSELLER123"}
```

### Error table

| HTTP | Code | Meaning / action |
|---:|---|---|
| 400 | `validation failed` | Correct the request and resend. |
| 400 | `insufficient_balance` | Fund the buyer or lower the amount. |
| 400 | `invalid_otp` | Ask for the correct OTP; stop when attempts reach zero. |
| 400 | `partner_secret_key_not_configured` | Ask the TrustMe operator to configure the key. |
| 401 | `signature_required` | Send both HMAC headers. |
| 401 | `stale_timestamp` | Sign with the current Unix timestamp. |
| 401 | `invalid_signature` | Recompute using exact URL and exact body bytes. |
| 401 | `unauthorized` | Check key, expiry, and revocation. |
| 403 | `insufficient_scope` | Request the required scope. |
| 403 | `partner_not_linked` | Ask the admin to link the key to a real treasury. |
| 404 | `buyer_not_found`, `seller_not_found`, `checkout_not_found` | Verify resource ownership and IDs. |
| 409 | `not_active` | Read checkout status; it is no longer active. |
| 410 | `expired` | Initiate a new checkout. |
| 423 | `otp_locked` | Cancel/refund or create a new checkout; stop guessing. |
| 503 | `chain_unavailable` | Retry later; the notice remains pending. |

### Partner test checklist

Use a staging database and admin-issued credentials. Verify buyer creation
and replay, per-buyer deposit addresses, missing/failed/under-confirmed and
wrong-destination deposits, a valid 5 USDT deposit producing 500 coupons,
worker-style deposit replay, checkout lock/replay, decimal amount rejection,
seller capture, commission balances, wrong OTP and five-attempt lock, expiry,
cancellation/refund, cross-partner 404s, key rotation/revocation, and both
route aliases. Whole coupons only: `"12.5"` is invalid.
