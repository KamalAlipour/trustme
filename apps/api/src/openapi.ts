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
