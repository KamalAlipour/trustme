import { describe, expect, it } from 'vitest';
import { approvalDisplay } from './disclosure';

describe('disclosure approval display', () => {
  it('keeps the approval code and expiry associated with its request', () => {
    expect(approvalDisplay('request-id', '042981', '2030-01-01T00:10:00.000Z')).toEqual({
      requestId: 'request-id',
      code: '042981',
      expiresAt: '2030-01-01T00:10:00.000Z',
    });
  });
});
