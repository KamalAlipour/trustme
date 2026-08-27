export const openapiDocument = {
  openapi: '3.0.3',
  info: { title: 'TrustMe Member API', version: '0.1.0' },
  paths: {
    '/v1/users': { post: { responses: { '201': { description: 'Created' }, '401': { description: 'Unauthorized' } } } },
    '/v1/users/{barcodeId}/balance': { get: { responses: { '200': { description: 'Balance' } } } },
    '/v1/transfers': { post: { responses: { '201': { description: 'Transfer posted' } } } },
    '/v1/escrows': { post: { responses: { '201': { description: 'Escrow created' } } } },
    '/v1/escrows/{id}/release': { post: { responses: { '200': { description: 'Escrow released' } } } },
    '/v1/escrows/{id}/cancel': { post: { responses: { '200': { description: 'Escrow cancelled' } } } },
    '/v1/withdrawals': { post: { responses: { '201': { description: 'Withdrawal requested' } } } },
    '/v1/withdrawals/{id}': { get: { responses: { '200': { description: 'Withdrawal status' } } } },
  },
} as const;
