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
    '/v1/withdrawals/{id}': { get: { responses: { '200': { description: 'Withdrawal status' } } } },
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
