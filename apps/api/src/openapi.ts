export const openapiDocument = {
  openapi: '3.0.3',
  info: { title: 'TrustMe Member API', version: '0.1.0' },
  components: {
    securitySchemes: {
      apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'tck_...' },
      HmacSignature: {
        type: 'apiKey',
        in: 'header',
        name: 'X-TC-Signature',
        description: 'Partner keys also require X-TC-Timestamp (Unix seconds, within 300 seconds). Sign `${timestamp}\\n${METHOD}\\n${originalUrl}\\n${sha256hex(rawBody)}` with the decrypted secret using HMAC-SHA256 and send lowercase hexadecimal.',
      },
    },
    schemas: {
      ValidationError: {
        type: 'object',
        required: ['error', 'fields'],
        properties: {
          error: { type: 'string', example: 'validation failed' },
          fields: {
            type: 'array',
            items: {
              type: 'object',
              required: ['path', 'message'],
              properties: {
                path: { type: 'string', description: 'Dotted request field path' },
                message: { type: 'string' },
              },
            },
          },
        },
      },
      MemberProfile: {
        type: 'object',
        properties: {
          commission: {
            type: 'object',
            required: ['rateBps', 'floorBps', 'canStrike', 'marketer', 'trainer', 'dispute'],
            properties: {
              rateBps: { type: 'integer' },
              floorBps: { type: 'integer' },
              canStrike: { type: 'boolean' },
              marketer: { type: 'object', nullable: true, properties: { barcodeId: { type: 'string' }, displayName: { type: 'string', nullable: true } } },
              trainer: { type: 'object', nullable: true, properties: { barcodeId: { type: 'string' }, displayName: { type: 'string', nullable: true } } },
              dispute: { type: 'object', nullable: true },
            },
          },
          referrals: {
            type: 'object',
            required: ['marketers', 'sellers', 'customers'],
            properties: {
              marketers: { $ref: '#/components/schemas/ReferralSummary' },
              sellers: { $ref: '#/components/schemas/ReferralSummary' },
              customers: { $ref: '#/components/schemas/ReferralSummary' },
            },
          },
          phoneVerified: { type: 'boolean' },
          phoneVerification: {
            type: 'object',
            nullable: true,
            properties: {
              pendingExpiresAt: { type: 'string', format: 'date-time' },
              deliveryStatus: { type: 'string', enum: ['PENDING', 'SENT', 'FAILED'] },
              deliveryError: { type: 'string', nullable: true },
              resendAvailableAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
      ReferralSummary: {
        type: 'object',
        required: ['count', 'earnedCoupons'],
        properties: { count: { type: 'integer' }, earnedCoupons: { type: 'string' } },
      },
      PartnerBuyerRequest: {
        type: 'object',
        additionalProperties: false,
        required: ['externalRef'],
        properties: {
          externalRef: { type: 'string', minLength: 1, maxLength: 128, example: 'order-buyer-123' },
          displayName: { type: 'string', maxLength: 64, example: 'Foreign Buyer' },
        },
      },
      PartnerBuyer: {
        type: 'object',
        required: ['buyerId', 'barcodeId', 'depositAddress', 'balanceCoupons'],
        properties: {
          buyerId: { type: 'string', format: 'uuid' },
          barcodeId: { type: 'string', example: 'TC12345678' },
          depositAddress: { type: 'string', nullable: true },
          balanceCoupons: { type: 'string', example: '500' },
        },
      },
      PartnerDepositRequest: {
        type: 'object',
        additionalProperties: false,
        required: ['buyerId', 'txHash'],
        properties: {
          buyerId: { type: 'string', format: 'uuid' },
          txHash: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$', example: '0x1111111111111111111111111111111111111111111111111111111111111111' },
        },
      },
      PartnerDepositResponse: {
        type: 'object',
        required: ['status', 'amountMicroUsdt', 'amountCoupons', 'transactionIds', 'balanceCoupons'],
        properties: {
          status: { type: 'string', enum: ['credited'] },
          amountMicroUsdt: { type: 'string', example: '5000000' },
          amountCoupons: { type: 'string', example: '500' },
          transactionIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
          balanceCoupons: { type: 'string', example: '500' },
        },
      },
      PartnerDepositNotice: {
        type: 'object',
        required: ['id', 'partnerUserId', 'buyerUserId', 'txHash', 'status', 'reason', 'amountMicroUsdt', 'createdAt', 'updatedAt', 'transactions'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          partnerUserId: { type: 'string', format: 'uuid' },
          buyerUserId: { type: 'string', format: 'uuid' },
          txHash: { type: 'string' },
          status: { type: 'string', enum: ['PENDING', 'CREDITED', 'REJECTED'] },
          reason: { type: 'string', nullable: true },
          amountMicroUsdt: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
          transactions: { type: 'array', items: { type: 'object', required: ['id', 'amountMicroUsdt', 'amountCoupons', 'status'], properties: { id: { type: 'string', format: 'uuid' }, amountMicroUsdt: { type: 'string' }, amountCoupons: { type: 'string' }, status: { type: 'string' } } } },
        },
      },
      PartnerCheckoutInitiateRequest: {
        type: 'object',
        additionalProperties: false,
        required: ['buyerId', 'sellerBarcodeId', 'amountCoupons', 'externalRef'],
        properties: {
          buyerId: { type: 'string', format: 'uuid' },
          sellerBarcodeId: { type: 'string', example: 'TCSELLER123' },
          amountCoupons: { type: 'string', pattern: '^[1-9]\\d*$', example: '500', description: 'Whole coupons only. 100 coupons = 1 USDT.' },
          externalRef: { type: 'string', minLength: 1, maxLength: 128, example: 'checkout-123' },
          expiresInSeconds: { type: 'integer', minimum: 60, maximum: 3600, default: 900, example: 900 },
        },
      },
      PartnerCheckout: {
        type: 'object',
        required: ['checkoutId', 'status', 'amountCoupons', 'expiresAt', 'sellerBarcodeId'],
        properties: {
          checkoutId: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['ACTIVE', 'RELEASED', 'CANCELLED', 'EXPIRED', 'LOCKED'] },
          otp: { type: 'string', pattern: '^\\d{4}$', nullable: true, example: '0427' },
          replayed: { type: 'boolean', example: false },
          amountCoupons: { type: 'string', example: '500' },
          expiresAt: { type: 'string', format: 'date-time' },
          settledAt: { type: 'string', format: 'date-time', nullable: true },
          sellerBarcodeId: { type: 'string' },
        },
      },
      PartnerCheckoutCaptureResponse: {
        type: 'object',
        required: ['checkoutId', 'status'],
        properties: {
          checkoutId: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['RELEASED'] },
          amountCoupons: { type: 'string', example: '500' },
          sellerBarcodeId: { type: 'string' },
          settledAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      PartnerCheckoutStatus: {
        type: 'object',
        required: ['checkoutId', 'status', 'amountCoupons', 'expiresAt', 'sellerBarcodeId'],
        properties: {
          checkoutId: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['ACTIVE', 'RELEASED', 'CANCELLED', 'LOCKED'] },
          amountCoupons: { type: 'string', example: '500' },
          expiresAt: { type: 'string', format: 'date-time' },
          sellerBarcodeId: { type: 'string' },
        },
      },
      PartnerCaptureRequest: {
        type: 'object',
        additionalProperties: false,
        required: ['checkoutId', 'otp'],
        properties: { checkoutId: { type: 'string', format: 'uuid' }, otp: { type: 'string', pattern: '^\\d{4}$', example: '0427' } },
      },
      PartnerCancelRequest: {
        type: 'object',
        additionalProperties: false,
        required: ['checkoutId'],
        properties: { checkoutId: { type: 'string', format: 'uuid' } },
      },
      PartnerError: {
        type: 'object',
        required: ['error'],
        properties: { error: { type: 'string', example: 'buyer_not_found' }, message: { type: 'string' } },
      },
    },
    parameters: {
      PartnerTimestamp: { name: 'X-TC-Timestamp', in: 'header', required: true, schema: { type: 'string', example: '1730000000' }, description: 'Unix timestamp in seconds; must be within ±300 seconds.' },
    },
  },
  paths: {
    '/api/v1/buyers': {
      post: {
        tags: ['Partner'], security: [{ apiKey: [], HmacSignature: [] }], parameters: [{ $ref: '#/components/parameters/PartnerTimestamp' }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/PartnerBuyerRequest' }, example: { externalRef: 'order-buyer-123', displayName: 'Foreign Buyer' } } } },
        responses: {
          '201': { description: 'Buyer created', content: { 'application/json': { schema: { $ref: '#/components/schemas/PartnerBuyer' } } } },
          '200': { description: 'Existing buyer for the same partner and externalRef', content: { 'application/json': { schema: { $ref: '#/components/schemas/PartnerBuyer' } } } },
          '400': { description: 'Invalid request', content: { 'application/json': { schema: { $ref: '#/components/schemas/PartnerError' } } } },
        },
      },
    },
    '/api/v1/buyers/{id}': {
      get: {
        tags: ['Partner'], security: [{ apiKey: [], HmacSignature: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { $ref: '#/components/parameters/PartnerTimestamp' }],
        responses: {
          '200': { description: 'Buyer details', content: { 'application/json': { schema: { $ref: '#/components/schemas/PartnerBuyer' } } } },
          '404': { description: 'Buyer is not owned by this partner', content: { 'application/json': { schema: { $ref: '#/components/schemas/PartnerError' } } } },
        },
      },
    },
    '/api/v1/webhooks/usdt-deposit': {
      post: {
        tags: ['Partner'], security: [{ apiKey: [], HmacSignature: [] }], parameters: [{ $ref: '#/components/parameters/PartnerTimestamp' }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/PartnerDepositRequest' }, example: { buyerId: '00000000-0000-0000-0000-000000000001', txHash: '0x1111111111111111111111111111111111111111111111111111111111111111' } } } },
        responses: {
          '200': { description: 'Credited or rejected', content: { 'application/json': { schema: { oneOf: [{ $ref: '#/components/schemas/PartnerDepositResponse' }, { $ref: '#/components/schemas/PartnerError' }] } } } },
          '202': { description: 'Receipt or confirmations are pending', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', example: 'pending' }, reason: { type: 'string', example: 'not_found' }, confirmations: { type: 'integer' }, required: { type: 'integer' } } } } } },
          '503': { description: 'Chain RPC unavailable', content: { 'application/json': { schema: { type: 'object', example: { error: 'chain_unavailable' } } } } },
        },
      },
    },
    '/api/v1/webhooks/usdt-deposit/{txHash}': {
      get: {
        tags: ['Partner'], security: [{ apiKey: [], HmacSignature: [] }], parameters: [{ name: 'txHash', in: 'path', required: true, schema: { type: 'string' } }, { $ref: '#/components/parameters/PartnerTimestamp' }],
        responses: {
          '200': { description: 'Partner-specific deposit notice and credited transactions', content: { 'application/json': { schema: { $ref: '#/components/schemas/PartnerDepositNotice' } } } },
          '404': { description: 'Deposit notice not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/PartnerError' } } } },
        },
      },
    },
    '/api/v1/checkout/initiate': {
      post: {
        tags: ['Partner'], security: [{ apiKey: [], HmacSignature: [] }], parameters: [{ $ref: '#/components/parameters/PartnerTimestamp' }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/PartnerCheckoutInitiateRequest' }, example: { buyerId: '00000000-0000-0000-0000-000000000001', sellerBarcodeId: 'TCSELLER123', amountCoupons: '500', externalRef: 'checkout-123', expiresInSeconds: 900 } } } },
        responses: {
          '201': { description: 'Checkout initiated; display the OTP once to the buyer', content: { 'application/json': { schema: { $ref: '#/components/schemas/PartnerCheckout' } } } },
          '200': { description: 'Replay for the same partner and externalRef; otp is null and replayed is true', content: { 'application/json': { schema: { $ref: '#/components/schemas/PartnerCheckout' } } } },
          '400': { description: 'Invalid amount or insufficient balance', content: { 'application/json': { schema: { $ref: '#/components/schemas/PartnerError' } } } },
          '404': { description: 'Buyer or seller not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/PartnerError' } } } },
        },
      },
    },
    '/api/v1/checkout/capture': {
      post: {
        tags: ['Partner'], security: [{ apiKey: [], HmacSignature: [] }], parameters: [{ $ref: '#/components/parameters/PartnerTimestamp' }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/PartnerCaptureRequest' }, example: { checkoutId: '00000000-0000-0000-0000-000000000002', otp: '0427' } } } },
        responses: {
          '200': { description: 'Checkout released or already released', content: { 'application/json': { schema: { $ref: '#/components/schemas/PartnerCheckoutCaptureResponse' } } } },
          '400': { description: 'Invalid OTP', content: { 'application/json': { schema: { type: 'object', required: ['error', 'attemptsRemaining'], properties: { error: { type: 'string', example: 'invalid_otp' }, attemptsRemaining: { type: 'integer' } } } } } },
          '410': { description: 'Checkout expired', content: { 'application/json': { schema: { $ref: '#/components/schemas/PartnerError' } } } },
          '423': { description: 'OTP locked after five failed attempts', content: { 'application/json': { schema: { $ref: '#/components/schemas/PartnerError' } } } },
        },
      },
    },
    '/api/v1/checkout/cancel': {
      post: {
        tags: ['Partner'], security: [{ apiKey: [], HmacSignature: [] }], parameters: [{ $ref: '#/components/parameters/PartnerTimestamp' }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/PartnerCancelRequest' }, example: { checkoutId: '00000000-0000-0000-0000-000000000002' } } } },
        responses: {
          '200': { description: 'Checkout cancelled and buyer refunded', content: { 'application/json': { schema: { type: 'object', required: ['checkoutId', 'status'], properties: { checkoutId: { type: 'string', format: 'uuid' }, status: { type: 'string', enum: ['CANCELLED', 'EXPIRED'] } } } } } },
          '404': { description: 'Checkout not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/PartnerError' } } } },
        },
      },
    },
    '/api/v1/checkout/{id}': {
      get: {
        tags: ['Partner'], security: [{ apiKey: [], HmacSignature: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { $ref: '#/components/parameters/PartnerTimestamp' }],
        responses: {
          '200': { description: 'Checkout status', content: { 'application/json': { schema: { $ref: '#/components/schemas/PartnerCheckoutStatus' } } } },
          '404': { description: 'Checkout not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/PartnerError' } } } },
        },
      },
    },
    '/v1/partner/market-average': {
      get: {
        security: [{ apiKey: [] }],
        responses: { '200': { description: 'Private network commission average' }, '401': { description: 'Unauthorized' }, '403': { description: 'Insufficient scope' } },
      },
    },
    '/v1/partner/reserves': {
      get: {
        security: [{ apiKey: [] }],
        responses: { '200': { description: 'Private reserve figures' }, '401': { description: 'Unauthorized' }, '403': { description: 'Insufficient scope' } },
      },
    },
    '/v1/auth/register': { post: { responses: { '201': { description: 'Registered member and tokens' }, '409': { description: 'Phone already registered' } } } },
    '/v1/auth/login': { post: { responses: { '200': { description: 'Member and tokens' }, '401': { description: 'Invalid phone or PIN' }, '423': { description: 'PIN temporarily locked' } } } },
    '/v1/auth/refresh': { post: { responses: { '200': { description: 'Rotated tokens' }, '401': { description: 'Unauthorized' } } } },
    '/v1/auth/pin-reset/request': { post: { responses: { '202': { description: 'Reset requested' }, '503': { description: 'Email delivery unavailable' } } } },
    '/v1/auth/pin-reset/confirm': { post: { responses: { '200': { description: 'Reset PIN and tokens' }, '401': { description: 'Invalid code' } } } },
    '/v1/me': {
      get: { responses: { '200': { description: 'Member profile, including commission trainer and referral summaries', content: { 'application/json': { schema: { $ref: '#/components/schemas/MemberProfile' } } } }, '401': { description: 'Unauthorized' } } },
      patch: { responses: { '200': { description: 'Updated member profile' } } },
    },
    '/v1/me/commission-rate': { put: { responses: { '200': { description: 'Updated commission profile' }, '400': { description: 'Rate is below the configured floor' } } } },
    '/v1/me/marketer': { put: { responses: { '200': { description: 'Updated marketer relationship' }, '409': { description: 'Marketer is already set' } } } },
    '/v1/me/trainer': {
      put: {
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['trainerBarcodeId', 'pin'], properties: { trainerBarcodeId: { type: 'string' }, pin: { type: 'string', pattern: '^\\d{4}$' } } } } } },
        responses: { '200': { description: 'Updated trainer relationship' }, '400': { description: 'Trainer referral cycle or self-referral' }, '409': { description: 'Trainer is already set' } },
      },
    },
    '/v1/me/commission-discounts': { post: { responses: { '200': { description: 'Discount granted', content: { 'application/json': { schema: { type: 'object', required: ['sellerBarcodeId', 'rateBps'], properties: { sellerBarcodeId: { type: 'string' }, rateBps: { type: 'integer' } } } } } }, '400': { description: 'Invalid discount' } } } },
    '/v1/me/commission-disputes/strike': { post: { responses: { '200': { description: 'Commission dispute strike recorded' }, '409': { description: 'Strike is not allowed' } } } },
    '/v1/me/commission-disputes/auto-resolve': { post: { responses: { '200': { description: 'Commission dispute auto-resolved' }, '409': { description: 'Dispute is not eligible' } } } },
    '/v1/me/identity': {
      get: { responses: { '200': { description: 'Country-aware identity policy and status' } } },
      post: {
        description: 'Check the authenticated member’s Iranian national ID against the mobile number stored on the account. Provider messages are not exposed.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['nationalCode'], properties: { nationalCode: { type: 'string', pattern: '^\\d{10}$' } } } } } },
        responses: {
          '200': { description: 'Identity verification result: VERIFIED, MISMATCH, or INCONCLUSIVE' },
          '400': { description: 'Invalid national code, missing phone number, or invalid Iranian mobile number' },
          '409': { description: 'Phone verification is required before Shahkar identity verification' },
          '429': { description: 'Rate limit or identity-check cap reached' },
          '503': { description: 'Identity verification is not configured' },
        },
      },
    },
    '/v1/me/identity/live-capture-session': {
      post: {
        description: 'Create a five-minute server-issued live identity capture session with a shuffled frame order and challenge code.',
        responses: { '201': { description: 'Live capture session' }, '400': { description: 'Country is required' }, '409': { description: 'Manual path is unavailable, review is pending, or identity is verified' } },
      },
    },
    '/v1/me/identity/manual-review': {
      post: {
        description: 'Submit all four frames captured in a live identity session for manual review.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['captureSessionId'], properties: { captureSessionId: { type: 'string', format: 'uuid' } } } } } },
        responses: { '201': { description: 'Manual identity review submitted' }, '400': { description: 'Country or required capture frame is missing' }, '403': { description: 'Capture session or frame is not owned by the member' }, '409': { description: 'Manual review is unavailable, expired, already pending, or identity is verified' } },
      },
    },
    '/v1/me/disclosures': { get: { responses: { '200': { description: 'Pending balance disclosure requests for the member' } } } },
    '/v1/me/disclosures/{id}/deny': { post: { responses: { '204': { description: 'Disclosure request denied' }, '404': { description: 'Disclosure request not found' }, '409': { description: 'Disclosure request is no longer pending' } } } },
    '/v1/me/country': { put: { responses: { '200': { description: 'Updated account country' }, '409': { description: 'Country cannot change after verification' } } } },
    '/v1/me/phone': { post: { responses: { '200': { description: 'Updated member profile with masked phone number' }, '202': { description: 'Phone saved and verification code queued' }, '400': { description: 'Invalid phone number or PIN' }, '409': { description: 'Phone is already registered or identity verification is complete' }, '423': { description: 'PIN temporarily locked' } } } },
    '/v1/me/phone/resend': { post: { responses: { '202': { description: 'Verification code queued' }, '400': { description: 'Phone is missing or invalid' }, '409': { description: 'Phone is already verified' }, '429': { description: 'Rate limit reached' } } } },
    '/v1/me/phone/verify': { post: { responses: { '200': { description: 'Phone verified and updated member profile' }, '400': { description: 'Code must be exactly six digits' }, '401': { description: 'Invalid phone verification code' } } } },
    '/v1/me/barcodes': { get: { responses: { '200': { description: 'Member barcode search results' } } } },
    '/v1/me/barcodes/{barcodeId}': { get: { responses: { '200': { description: 'Member barcode details' }, '404': { description: 'Member not found' } } } },
    '/v1/me/pin': { post: { responses: { '204': { description: 'PIN changed' } } } },
    '/v1/me/email': { post: { responses: { '202': { description: 'Email verification requested' }, '503': { description: 'Email delivery unavailable' } } } },
    '/v1/me/email/verify': { post: { responses: { '200': { description: 'Verified member profile' } } } },
    '/v1/me/escrow/config': {
      get: {
        responses: {
          '200': {
            description: 'Escrow contract, RPC, and wallet configuration',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['contractAddress', 'chainId', 'usdtAddress', 'rpcUrl', 'decimals', 'walletConnectProjectId', 'web3AuthClientId', 'cardTopUpEnabled', 'enabled'],
                  properties: {
                    contractAddress: { type: 'string', nullable: true },
                    chainId: { type: 'integer' },
                    usdtAddress: { type: 'string' },
                    rpcUrl: { type: 'string', format: 'uri', nullable: true },
                    decimals: { type: 'integer' },
                    walletConnectProjectId: { type: 'string', nullable: true },
                    web3AuthClientId: { type: 'string', nullable: true },
                    cardTopUpEnabled: { type: 'boolean' },
                    enabled: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/v1/me/card-topup/session': {
      post: {
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { amountUsdt: { type: 'string', pattern: '^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,2})?$' } },
                example: { amountUsdt: '25.00' },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Single-use Transak widget session',
            content: { 'application/json': { schema: { type: 'object', required: ['url', 'expiresAt'], properties: { url: { type: 'string', format: 'uri' }, expiresAt: { type: 'string', format: 'date-time' } } } } },
          },
          '400': { description: 'Invalid amount' },
          '403': { description: 'Identity verification required' },
          '409': { description: 'Deposit address is unavailable' },
          '502': { description: 'Transak card top-up is unavailable' },
          '503': { description: 'Transak card top-up is not configured' },
        },
      },
    },
    '/v1/me/wallets': {
      get: { responses: { '200': { description: 'Registered member wallets' }, '503': { description: 'Escrow is not configured' } } },
      post: { responses: { '201': { description: 'Primary wallet registered' }, '409': { description: 'Wallet belongs to another member' }, '503': { description: 'Escrow is not configured' } } },
    },
    '/v1/me/wallets/{id}': { delete: { responses: { '204': { description: 'Wallet removed' }, '404': { description: 'Wallet not found' }, '409': { description: 'Wallet cannot be removed while escrow is locked or pending' } } } },
    '/v1/me/escrow': { get: { responses: { '200': { description: 'Member prepaid escrow balance' }, '503': { description: 'Escrow is not configured' } } } },
    '/v1/me/escrow/pay-codes': {
      post: {
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['code', 'pin'],
                properties: {
                  code: { type: 'string', pattern: '^\\d{4}$' },
                  maxAmount: { type: 'string' },
                  merchantBarcodeId: { type: 'string' },
                  amount: { type: 'string' },
                  amountCoupons: { type: 'string', pattern: '^[1-9][0-9]*$' },
                  pin: { type: 'string', pattern: '^\\d{4}$' },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Payment code created without returning its plaintext code', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, expiresAt: { type: 'string', format: 'date-time' }, maxAmount: { type: 'string' }, amount: { type: 'string', nullable: true }, amountCoupons: { type: 'string', nullable: true }, merchantBarcodeId: { type: 'string', nullable: true } } } } } },
          '400': { description: 'Invalid payment code or amount' },
          '503': { description: 'Escrow is not configured' },
        },
      },
    },
    '/v1/me/escrow/pay-codes/active': {
      get: {
        responses: {
          '200': {
            description: 'Active payment code metadata',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  nullable: true,
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    status: { type: 'string' },
                    expiresAt: { type: 'string', format: 'date-time' },
                    maxAmount: { type: 'string' },
                    amount: { type: 'string', nullable: true },
                    amountCoupons: { type: 'string', nullable: true },
                    merchantBarcodeId: { type: 'string', nullable: true },
                    wrongAttempts: { type: 'integer' },
                  },
                },
              },
            },
          },
          '503': { description: 'Escrow is not configured' },
        },
      },
    },
    '/v1/me/escrow/pay-codes/incoming': {
      get: {
        responses: {
          '200': {
            description: 'Incoming directed payment codes',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    items: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string', format: 'uuid' },
                          amount: { type: 'string' },
                          amountCoupons: { type: 'string' },
                          expiresAt: { type: 'string', format: 'date-time' },
                          buyerBarcodeId: { type: 'string' },
                          buyerDisplayName: { type: 'string', nullable: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '503': { description: 'Escrow is not configured' },
        },
      },
    },
    '/v1/me/escrow/pay-codes/{id}': {
      get: {
        responses: {
          '200': {
            description: 'Buyer payment code status',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    status: { type: 'string' },
                    amount: { type: 'string', nullable: true },
                    amountCoupons: { type: 'string', nullable: true },
                    expiresAt: { type: 'string', format: 'date-time' },
                    merchantBarcodeId: { type: 'string', nullable: true },
                    wrongAttempts: { type: 'integer' },
                  },
                },
              },
            },
          },
          '404': { description: 'Payment code not found' },
        },
      },
      delete: { responses: { '204': { description: 'Payment code cancelled' }, '404': { description: 'Payment code not found' } } },
    },
    '/v1/me/escrow/settlements': {
      get: { responses: { '200': { description: 'Merchant escrow settlement history' } } },
      post: { responses: { '201': { description: 'Escrow settlement queued' }, '503': { description: 'Escrow is not configured' } } },
    },
    '/v1/me/escrow/unloads': {
      get: { responses: { '200': { description: 'Escrow unload history' } } },
      post: { responses: { '201': { description: 'Escrow unload queued' }, '503': { description: 'Escrow is not configured' } } },
    },
    '/v1/me/devices': { get: { responses: { '200': { description: 'Member devices' } } } },
    '/v1/me/devices/{id}': { delete: { responses: { '204': { description: 'Device revoked' }, '403': { description: 'Forbidden' } } } },
    '/v1/me/logout': { post: { responses: { '204': { description: 'Current device revoked' } } } },
    '/v1/me/balance': { get: { responses: { '200': { description: 'Member balance' } } } },
    '/v1/me/withdrawal-availability': { get: { responses: { '200': { description: 'Member withdrawal availability' } } } },
    '/v1/me/transactions': { get: { responses: { '200': { description: 'Member transaction history' } } } },
    '/v1/me/transfers': { post: { responses: { '201': { description: 'Transfer posted' } } } },
    '/v1/me/escrows': { post: { responses: { '201': { description: 'Escrow created' } } } },
    '/v1/me/escrows/{id}/release': { post: { responses: { '200': { description: 'Escrow released' }, '403': { description: 'Forbidden' } } } },
    '/v1/me/escrows/{id}/cancel': { post: { responses: { '200': { description: 'Escrow cancelled' }, '403': { description: 'Forbidden' } } } },
    '/v1/me/withdrawals': { post: { responses: { '201': { description: 'Withdrawal requested' } } } },
    '/v1/me/withdrawals/quote': { get: { responses: { '200': { description: 'Withdrawal fee quote' }, '400': { description: 'Withdrawal quote rejected' } } } },
    '/v1/me/contacts': {
      get: { responses: { '200': { description: 'Member contacts' } } },
      post: { responses: { '201': { description: 'Contact created' } } },
    },
    '/v1/me/contacts/{id}': {
      patch: { responses: { '200': { description: 'Contact updated' }, '403': { description: 'Forbidden' } } },
      delete: { responses: { '204': { description: 'Contact deleted' }, '403': { description: 'Forbidden' } } },
    },
    '/v1/me/loans': {
      get: { responses: { '200': { description: 'Member loans' } } },
      post: { responses: { '201': { description: 'Loan requested' } } },
    },
    '/v1/me/loans/{id}/repay': { post: { responses: { '200': { description: 'Loan repayment posted' }, '403': { description: 'Forbidden' } } } },
    '/v1/me/guarantees': { get: { responses: { '200': { description: 'Member guarantees' } } } },
    '/v1/me/guarantees/{id}/approve': { post: { responses: { '200': { description: 'Guarantee approved' }, '403': { description: 'Forbidden' } } } },
    '/v1/me/guarantees/{id}/activate': { post: { responses: { '200': { description: 'Guarantee activated' }, '403': { description: 'Forbidden' } } } },
    '/v1/me/guarantees/{id}/decline': { post: { responses: { '200': { description: 'Guarantee declined' }, '403': { description: 'Forbidden' } } } },
    '/v1/me/media': { post: { responses: { '201': { description: 'Media uploaded' }, '413': { description: 'Media too large' }, '415': { description: 'Unsupported media type' } } } },
    '/v1/me/media/{id}': { get: { responses: { '200': { description: 'Media download' }, '404': { description: 'Not found' } } } },
    '/v1/me/refunds': {
      get: { responses: { '200': { description: 'Refund requests' } } },
      post: { responses: { '201': { description: 'Refund request created' }, '409': { description: 'Pending refund exists' } } },
    },
    '/v1/me/refunds/{id}': {
      get: { responses: { '200': { description: 'Refund detail' }, '404': { description: 'Not found' } } },
    },
    '/v1/me/refunds/{id}/approve': { post: { responses: { '200': { description: 'Refund approved' }, '409': { description: 'Refund unavailable' } } } },
    '/v1/me/refunds/{id}/reject': { post: { responses: { '200': { description: 'Refund rejected' } } } },
    '/v1/me/charities': { get: { responses: { '200': { description: 'Active charities' } } } },
    '/v1/me/charities/{id}/donations': { post: { responses: { '201': { description: 'Donation posted' } } } },
    '/v1/me/aid-requests': {
      get: { responses: { '200': { description: 'Applicant aid requests' } } },
      post: { responses: { '201': { description: 'Aid request created' } } },
    },
    '/v1/me/aid-requests/{id}/documents': { post: { responses: { '200': { description: 'Aid documents attached' } } } },
  '/v1/me/charity-requests': { get: { responses: { '200': { description: 'Charity requests' } } } },
  '/v1/me/charity-requests/{id}/approve': { post: { responses: { '200': { description: 'Aid approved' }, '409': { description: 'Insufficient charity balance' } } } },
  '/v1/me/charity-guarantees': { get: { responses: { '200': { description: 'Purchase guarantees backed by the agent' } } } },
  '/v1/me/charity-guarantees/{id}/revoke': { post: { responses: { '200': { description: 'Purchase guarantee revoked' } } } },
    '/v1/me/charity-requests/{id}/reject': { post: { responses: { '200': { description: 'Aid rejected' } } } },
    '/v1/me/charity-requests/{id}/request-documents': { post: { responses: { '200': { description: 'Documents requested' } } } },
    '/v1/users': { post: { responses: { '201': { description: 'Created' }, '401': { description: 'Unauthorized' } } } },
    '/v1/users/{barcodeId}/balance': { get: { responses: { '200': { description: 'Balance' } } } },
    '/v1/transfers': { post: { responses: { '201': { description: 'Transfer posted' } } } },
    '/v1/escrows': { post: { responses: { '201': { description: 'Escrow created' } } } },
    '/v1/escrows/{id}/release': { post: { responses: { '200': { description: 'Escrow released' } } } },
    '/v1/escrows/{id}/cancel': { post: { responses: { '200': { description: 'Escrow cancelled' } } } },
    '/v1/withdrawals': { post: { responses: { '201': { description: 'Withdrawal requested' } } } },
    '/v1/withdrawals/availability': { get: { responses: { '200': { description: 'Withdrawal availability and blockers' } } } },
    '/v1/public/display-unit': {
      get: {
        responses: {
          '200': {
            description: 'Public member-facing display unit names',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['en', 'fa'],
                  properties: {
                    en: {
                      type: 'object',
                      required: ['singular', 'plural'],
                      properties: {
                        singular: { type: 'string', example: 'US cent' },
                        plural: { type: 'string', example: 'US cents' },
                      },
                    },
                    fa: { type: 'string', example: 'سنت دلار آمریکا' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/v1/public/reserves': { get: { responses: { '200': { description: 'Public real and demo reserve figures' } } } },
    '/v1/public/ledger': { get: { responses: { '200': { description: 'Anonymized completed public ledger feed' } } } },
    '/v1/public/barcodes/{barcodeId}': { get: { responses: { '200': { description: 'Public barcode status only' }, '404': { description: 'Member not found' } } } },
    '/v1/public/barcodes/{barcodeId}/disclosure': { post: { responses: { '201': { description: 'Created one-time disclosure request' }, '409': { description: 'Disclosure request already pending' } } } },
    '/v1/public/disclosures/{requestId}/confirm': { post: { responses: { '200': { description: 'One-time approved balance disclosure' }, '401': { description: 'Invalid disclosure code' }, '410': { description: 'Disclosure request expired or already consumed' } } } },
    '/v1/withdrawals/{id}': { get: { responses: { '200': { description: 'Withdrawal status' } } } },
    '/v1/loans': {
      get: { responses: { '200': { description: 'Member loans' } } },
      post: { responses: { '201': { description: 'Loan requested' } } },
    },
    '/v1/loans/{id}/disburse': { post: { responses: { '200': { description: 'Loan disbursed' } } } },
    '/v1/loans/{id}/repay': { post: { responses: { '200': { description: 'Loan repayment posted' } } } },
    '/v1/loans/{id}/claim': { post: { responses: { '200': { description: 'Guarantees claimed' } } } },
    '/v1/guarantees': { get: { responses: { '200': { description: 'Member guarantees' } } } },
    '/v1/guarantees/{id}/approve': { post: { responses: { '200': { description: 'Guarantee approved and locked' } } } },
    '/v1/guarantees/{id}/activate': { post: { responses: { '200': { description: 'Guarantee activated' } } } },
    '/v1/guarantees/{id}/cancel': { post: { responses: { '200': { description: 'Guarantee cancelled' } } } },
    '/v1/guarantees/{id}/decline': { post: { responses: { '200': { description: 'Guarantee declined' } } } },
    '/admin/login': {
      post: {
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['username', 'password'],
                properties: {
                  username: { type: 'string', description: 'Admin username' },
                  password: { type: 'string', format: 'password' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Admin JWT' }, '401': { description: 'Invalid credentials' } },
      },
    },
    '/admin/overview': { get: { responses: { '200': { description: 'Admin overview' } } } },
    '/admin/api-keys': {
      get: { responses: { '200': { description: 'Admin API key list' }, '403': { description: 'Admin role required' } } },
      post: { responses: { '201': { description: 'Created API key (raw key shown once)' }, '400': { description: 'Invalid API key request' }, '403': { description: 'Admin role required' } } },
    },
    '/admin/api-keys/{id}/revoke': { post: { responses: { '200': { description: 'API key revoked' }, '403': { description: 'Admin role required' }, '404': { description: 'API key not found' } } } },
    '/admin/settings': {
      get: { responses: { '200': { description: 'Admin settings' } } },
      patch: { responses: { '200': { description: 'Updated admin settings' } } },
    },
    '/admin/withdrawals': { get: { responses: { '200': { description: 'Admin withdrawal queue' } } } },
    '/admin/withdrawals/{id}/approve': { post: { responses: { '200': { description: 'Withdrawal approved' } } } },
    '/admin/withdrawals/{id}/reject': { post: { responses: { '200': { description: 'Withdrawal rejected' } } } },
    '/admin/identity-reviews': { get: { responses: { '200': { description: 'Admin identity review queue' }, '403': { description: 'Reviewer role required' } } } },
    '/admin/identity-reviews/{id}/media/{assetId}': { get: { responses: { '200': { description: 'Protected identity-review media' }, '403': { description: 'Reviewer role required' }, '404': { description: 'Media not found or no longer attached' } } } },
    '/admin/identity-reviews/{id}/approve': { post: { responses: { '200': { description: 'Identity review approved' }, '409': { description: 'Review is no longer pending or manual path is unavailable' } } } },
    '/admin/identity-reviews/{id}/reject': { post: { responses: { '200': { description: 'Identity review rejected' }, '409': { description: 'Review is no longer pending' } } } },
    '/admin/ledger': { get: { responses: { '200': { description: 'Admin ledger entries' } } } },
    '/admin/charities': { post: { responses: { '201': { description: 'Charity created' } } } },
    '/admin/charities/{id}': { patch: { responses: { '200': { description: 'Charity updated' } } } },
    '/admin/charities/{id}/agents': { post: { responses: { '201': { description: 'Charity agent added' } } } },
    '/admin/charities/{id}/agents/{userId}': { delete: { responses: { '200': { description: 'Charity agent revoked' } } } },
  },
} as const;
