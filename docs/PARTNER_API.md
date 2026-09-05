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
{"buyerId":"uuid","sellerBarcodeId":"TC...","amountCoupons":"12.50","externalRef":"order-123"}
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
