export const openapiDocument = {
  openapi: '3.0.3',
  info: { title: 'TrustMe Member API', version: '0.1.0' },
  components: {
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
    },
  },
  paths: {
    '/v1/auth/register': { post: { responses: { '201': { description: 'Registered member and tokens' }, '409': { description: 'Phone already registered' } } } },
    '/v1/auth/login': { post: { responses: { '200': { description: 'Member and tokens' }, '401': { description: 'Invalid phone or PIN' }, '423': { description: 'PIN temporarily locked' } } } },
    '/v1/auth/refresh': { post: { responses: { '200': { description: 'Rotated tokens' }, '401': { description: 'Unauthorized' } } } },
    '/v1/auth/pin-reset/request': { post: { responses: { '202': { description: 'Reset requested' }, '503': { description: 'Email delivery unavailable' } } } },
    '/v1/auth/pin-reset/confirm': { post: { responses: { '200': { description: 'Reset PIN and tokens' }, '401': { description: 'Invalid code' } } } },
    '/v1/me': {
      get: { responses: { '200': { description: 'Member profile' }, '401': { description: 'Unauthorized' } } },
      patch: { responses: { '200': { description: 'Updated member profile' } } },
    },
    '/v1/me/pin': { post: { responses: { '204': { description: 'PIN changed' } } } },
    '/v1/me/email': { post: { responses: { '202': { description: 'Email verification requested' }, '503': { description: 'Email delivery unavailable' } } } },
    '/v1/me/email/verify': { post: { responses: { '200': { description: 'Verified member profile' } } } },
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
    '/v1/users': { post: { responses: { '201': { description: 'Created' }, '401': { description: 'Unauthorized' } } } },
    '/v1/users/{barcodeId}/balance': { get: { responses: { '200': { description: 'Balance' } } } },
    '/v1/transfers': { post: { responses: { '201': { description: 'Transfer posted' } } } },
    '/v1/escrows': { post: { responses: { '201': { description: 'Escrow created' } } } },
    '/v1/escrows/{id}/release': { post: { responses: { '200': { description: 'Escrow released' } } } },
    '/v1/escrows/{id}/cancel': { post: { responses: { '200': { description: 'Escrow cancelled' } } } },
    '/v1/withdrawals': { post: { responses: { '201': { description: 'Withdrawal requested' } } } },
    '/v1/withdrawals/availability': { get: { responses: { '200': { description: 'Withdrawal availability and blockers' } } } },
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
    '/admin/settings': {
      get: { responses: { '200': { description: 'Admin settings' } } },
      patch: { responses: { '200': { description: 'Updated admin settings' } } },
    },
    '/admin/withdrawals': { get: { responses: { '200': { description: 'Admin withdrawal queue' } } } },
    '/admin/withdrawals/{id}/approve': { post: { responses: { '200': { description: 'Withdrawal approved' } } } },
    '/admin/withdrawals/{id}/reject': { post: { responses: { '200': { description: 'Withdrawal rejected' } } } },
    '/admin/ledger': { get: { responses: { '200': { description: 'Admin ledger entries' } } } },
  },
} as const;
