import { createHash } from 'node:crypto';
import { AppError } from '../../../common/exceptions/app-error';
import { replayOf } from '../order-replay';
import { orderRequestHash } from '../order-request-hash';

describe('orderRequestHash', () => {
  it('is the sha256 of the canonical body: deterministic, 64 hex characters', () => {
    const hash = orderRequestHash({ quoteId: 'q1' });
    expect(hash).toBe(createHash('sha256').update('["q1"]').digest('hex'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(orderRequestHash({ quoteId: 'q1' })).toBe(hash);
  });

  it('another quote is another request', () => {
    expect(orderRequestHash({ quoteId: 'q2' })).not.toBe(orderRequestHash({ quoteId: 'q1' }));
  });
});

describe('replayOf', () => {
  const stored = { id: 'o1', requestHash: 'a'.repeat(64) };

  it('no order under the key: null (the purchase goes on)', () => {
    expect(replayOf(null, 'a'.repeat(64))).toBeNull();
  });

  it('the same body: the stored order itself', () => {
    expect(replayOf(stored, 'a'.repeat(64))).toBe(stored);
  });

  it('another body under the key: 409 IDEMPOTENCY_CONFLICT without details', () => {
    let caught: unknown;
    try {
      replayOf(stored, 'b'.repeat(64));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409, details: undefined });
  });
});
