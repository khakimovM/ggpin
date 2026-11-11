import { describe, expect, it } from 'vitest';
import { ApiError, type ApiErrorCode } from '../../../lib/api/errors';
import { classifyOrderError, resolvesAttempt, type Channel } from '../pay-outcome';

// `fromServer` marks an answer in OUR envelope; a proxy's page has none.
const envelope = (code: ApiErrorCode, status: number, details?: unknown, retryAfterSec?: number) =>
  new ApiError({ status, code, details, retryAfterSec, fromServer: true });
const proxy = (code: ApiErrorCode, status: number) => new ApiError({ status, code });
const classify = (e: unknown) => classifyOrderError(e, 'q1');

describe('classifyOrderError: every answer of POST /orders becomes one state of the checkout', () => {
  it('INSUFFICIENT_BALANCE carries the SERVER numbers, untouched', () => {
    const outcome = classify(
      envelope('INSUFFICIENT_BALANCE', 422, {
        balance: '8540000',
        required: '12245000',
        shortfall: '3705000',
      }),
    );
    expect(outcome).toEqual({
      kind: 'insufficient',
      balance: '8540000',
      required: '12245000',
      shortfall: '3705000',
    });
  });

  it('INSUFFICIENT_BALANCE without usable numbers is a plain error, never invented figures', () => {
    for (const details of [
      undefined,
      {},
      { balance: '1', required: '2' },
      { balance: 'x', required: '2', shortfall: '1' },
    ]) {
      expect(classify(envelope('INSUFFICIENT_BALANCE', 422, details))).toEqual({
        kind: 'failed',
        code: 'INSUFFICIENT_BALANCE',
      });
    }
  });

  it("QUOTE_EXPIRED (410) and the API's own 404 both need a new quote", () => {
    expect(classify(envelope('QUOTE_EXPIRED', 410))).toEqual({ kind: 'expired' });
    expect(classify(envelope('NOT_FOUND', 404))).toEqual({ kind: 'expired' });
  });

  it('QUOTE_ALREADY_USED opens the order the quote already became', () => {
    expect(classify(envelope('QUOTE_ALREADY_USED', 409, { orderId: 'cm0order1' }))).toEqual({
      kind: 'ok',
      orderId: 'cm0order1',
    });
  });

  it('QUOTE_ALREADY_USED without a valid order id is a plain error, never a guessed order', () => {
    for (const details of [undefined, {}, { orderId: '../x' }, { orderId: 'cm0order1', x: 1 }]) {
      expect(classify(envelope('QUOTE_ALREADY_USED', 409, details))).toEqual({
        kind: 'failed',
        code: 'QUOTE_ALREADY_USED',
      });
    }
  });

  it('IDEMPOTENCY_CONFLICT is an ordinary error, never "refresh and go on"', () => {
    expect(classify(envelope('IDEMPOTENCY_CONFLICT', 409))).toEqual({
      kind: 'failed',
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('PURCHASE_FROZEN (403) is its own state, with support', () => {
    expect(classify(envelope('PURCHASE_FROZEN', 403))).toEqual({ kind: 'frozen' });
  });

  it('a 429 carries how long to wait', () => {
    expect(classify(envelope('RATE_LIMITED', 429, undefined, 12))).toEqual({
      kind: 'failed',
      code: 'RATE_LIMITED',
      retryAfterSec: 12,
    });
    expect(classify(envelope('RATE_LIMITED', 429))).toEqual({
      kind: 'failed',
      code: 'RATE_LIMITED',
    });
  });

  it.each<[ApiErrorCode, number]>([
    ['VALIDATION_ERROR', 400],
    ['USER_BLOCKED', 403],
  ])(
    '%s from the API is a failure with its own code (the server refused, no order)',
    (code, status) => {
      expect(classify(envelope(code, status))).toEqual({ kind: 'failed', code });
    },
  );

  it.each<[string, unknown]>([
    ['offline (a fetch TypeError)', new TypeError('Failed to fetch')],
    ['no response at all (NETWORK)', proxy('NETWORK', 0)],
    ['a timeout (NETWORK)', proxy('NETWORK', 0)],
    ['a 500 in our envelope', envelope('INTERNAL_ERROR', 500)],
    ['a 503 with a known code', envelope('FULFILLMENT_UNAVAILABLE', 503)],
    ['a 408', envelope('VALIDATION_ERROR', 408)],
    ['a proxy 502 page', proxy('INTERNAL_ERROR', 502)],
    ['a proxy HTML 404', proxy('NOT_FOUND', 404)],
    ['a proxy HTML 429', proxy('RATE_LIMITED', 429)],
    ['a 2xx body that does not match the schema', proxy('INTERNAL_ERROR', 200)],
  ])('%s is UNCERTAIN: the order may exist, the quote id is kept', (_name, failure) => {
    expect(classify(failure)).toEqual({ kind: 'uncertain', quoteId: 'q1' });
  });

  it('a request that never left is certain: a 401 and a malformed key', () => {
    expect(classify(proxy('UNAUTHORIZED', 401))).toEqual({ kind: 'failed', code: 'UNAUTHORIZED' });
    expect(classify(proxy('VALIDATION_ERROR', 400))).toEqual({
      kind: 'failed',
      code: 'VALIDATION_ERROR',
    });
  });
});

describe('resolvesAttempt: which answers end the doubt', () => {
  const resolves = (error: unknown, channel: Channel, retry: boolean) =>
    resolvesAttempt(error, classify(error), channel, retry);

  it.each<[string, ApiError]>([
    ['410', envelope('QUOTE_EXPIRED', 410)],
    ['422', envelope('INSUFFICIENT_BALANCE', 422)],
    ['409 QUOTE_ALREADY_USED', envelope('QUOTE_ALREADY_USED', 409, { orderId: 'cm0order1' })],
  ])('a retry answered by an enveloped %s is resolved, on both channels', (_n, error) => {
    expect(resolves(error, 'tg', true)).toBe(true);
    expect(resolves(error, 'web', true)).toBe(true);
  });

  it("the API's 404 on a retry resolves in the Mini App only (on the web it can be the CSRF guard)", () => {
    const notFound = envelope('NOT_FOUND', 404);
    expect(resolves(notFound, 'tg', true)).toBe(true);
    expect(resolves(notFound, 'web', true)).toBe(false);
  });

  it('an answer without our envelope never resolves a retry, whatever its status', () => {
    for (const failure of [
      proxy('NOT_FOUND', 404),
      proxy('INTERNAL_ERROR', 410),
      proxy('INTERNAL_ERROR', 422),
      proxy('INTERNAL_ERROR', 502),
    ]) {
      expect(resolves(failure, 'tg', true)).toBe(false);
      expect(resolves(failure, 'web', true)).toBe(false);
    }
  });

  it('a 400, 403 or 429 on a retry proves nothing about the lost request', () => {
    for (const refusal of [
      envelope('VALIDATION_ERROR', 400),
      envelope('PURCHASE_FROZEN', 403),
      envelope('USER_BLOCKED', 403),
      envelope('RATE_LIMITED', 429),
      envelope('IDEMPOTENCY_CONFLICT', 409),
    ]) {
      expect(resolves(refusal, 'tg', true)).toBe(false);
    }
  });

  it('the FIRST attempt is resolved by any clear refusal, even a 400, 403, 429 or a web 404', () => {
    for (const refusal of [
      envelope('VALIDATION_ERROR', 400),
      envelope('PURCHASE_FROZEN', 403),
      envelope('RATE_LIMITED', 429),
      envelope('NOT_FOUND', 404),
      envelope('QUOTE_EXPIRED', 410),
      proxy('UNAUTHORIZED', 401),
    ]) {
      expect(resolves(refusal, 'web', false)).toBe(true);
    }
  });

  it('the FIRST attempt stays unresolved when the answer is doubtful', () => {
    for (const doubt of [
      proxy('NETWORK', 0),
      proxy('NOT_FOUND', 404),
      envelope('INTERNAL_ERROR', 500),
    ]) {
      expect(resolves(doubt, 'tg', false)).toBe(false);
    }
  });
});

describe('only the right status for the code ends a doubt (docs/04 pairs)', () => {
  const details: Partial<Record<ApiErrorCode, unknown>> = {
    INSUFFICIENT_BALANCE: { balance: '1', required: '2', shortfall: '1' },
    QUOTE_ALREADY_USED: { orderId: 'cm0order1' },
  };
  const pairs: Array<[ApiErrorCode, number]> = [
    ['QUOTE_EXPIRED', 410],
    ['INSUFFICIENT_BALANCE', 422],
    ['QUOTE_ALREADY_USED', 409],
    ['NOT_FOUND', 404],
  ];

  it.each(pairs)('%s on %i resolves a check (NOT_FOUND only in the Mini App)', (code, status) => {
    const error = envelope(code, status, details[code]);
    expect(resolvesAttempt(error, classify(error), 'tg', true)).toBe(true);
    expect(resolvesAttempt(error, classify(error), 'web', true)).toBe(code !== 'NOT_FOUND');
  });

  const wrong: Array<[ApiErrorCode, number]> = [
    ['QUOTE_EXPIRED', 400],
    ['QUOTE_EXPIRED', 404],
    ['QUOTE_EXPIRED', 422],
    ['QUOTE_EXPIRED', 200],
    ['INSUFFICIENT_BALANCE', 400],
    ['INSUFFICIENT_BALANCE', 410],
    ['QUOTE_ALREADY_USED', 400],
    ['QUOTE_ALREADY_USED', 422],
    ['NOT_FOUND', 400],
    ['NOT_FOUND', 410],
    ['NOT_FOUND', 403],
    ['PURCHASE_FROZEN', 400],
    ['RATE_LIMITED', 400],
  ];

  it.each(wrong)(
    '%s on a %i is not one of our answers: uncertain, whatever the channel',
    (code, status) => {
      const error = envelope(code, status, details[code]);
      expect(classify(error)).toEqual({ kind: 'uncertain', quoteId: 'q1' });
      for (const retry of [true, false]) {
        expect(resolvesAttempt(error, classify(error), 'tg', retry)).toBe(false);
        expect(resolvesAttempt(error, classify(error), 'web', retry)).toBe(false);
      }
    },
  );
});
