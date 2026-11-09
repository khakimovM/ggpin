import type { PaymentMethodsResponse } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../lib/api/errors';
import { fromQuery, safeFrom } from '../topup-from';
import { amountProblem, limitsOf, quickAmounts, type TopupLimits } from '../topup-limits';
import { classifyCreateError, rangeMessage } from '../topup-outcome';
import { intentPollInterval } from '../use-intent-status';

const methods = (over: Partial<PaymentMethodsResponse[number]> = {}): PaymentMethodsResponse => [
  {
    code: 'P2P_CARD',
    available: true,
    banks: [
      { bank: 'HUMO', available: true },
      { bank: 'UZCARD', available: false },
    ],
    minTiyin: '500000',
    maxTiyin: '200000000',
    stepTiyin: '100000',
    ...over,
  },
];
const LIMITS: TopupLimits = { minSom: '5000', maxSom: '2000000', stepSom: '1000', banks: ['HUMO'] };

describe('limitsOf', () => {
  it('turns the server’s tiyin limits into so‘m and keeps the banks with room', () => {
    expect(limitsOf(methods())).toEqual(LIMITS);
  });

  it('is null when the method is off, missing, or has no bank with room', () => {
    expect(limitsOf(methods({ available: false }))).toBeNull();
    expect(limitsOf([])).toBeNull();
    expect(
      limitsOf(
        methods({
          banks: [
            { bank: 'HUMO', available: false },
            { bank: 'UZCARD', available: false },
          ],
        }),
      ),
    ).toBeNull();
  });
});

describe('amountProblem', () => {
  it('empty is no error; min, max and step are told apart; the edges are allowed', () => {
    expect(amountProblem('', LIMITS)).toBeNull();
    expect(amountProblem('4000', LIMITS)).toBe('min');
    expect(amountProblem('2001000', LIMITS)).toBe('max');
    expect(amountProblem('5500', LIMITS)).toBe('step');
    expect(amountProblem('5000', LIMITS)).toBeNull();
    expect(amountProblem('2000000', LIMITS)).toBeNull();
    expect(amountProblem('50000', LIMITS)).toBeNull();
  });
});

describe('quickAmounts', () => {
  it('keeps only the amounts the limits allow', () => {
    expect(quickAmounts(LIMITS)).toEqual(['20000', '50000', '100000', '200000']);
    expect(quickAmounts({ ...LIMITS, maxSom: '100000' })).toEqual(['20000', '50000', '100000']);
    expect(quickAmounts({ ...LIMITS, stepSom: '30000', minSom: '30000' })).toEqual([]);
  });
});

describe('classifyCreateError', () => {
  const server = (code: ApiError['code'], status: number, details?: unknown) =>
    new ApiError({ status, code, details, fromServer: true });

  it('a waiting request (409) and a same-key conflict name the request', () => {
    expect(
      classifyCreateError(server('TOPUP_ALREADY_PENDING', 409, { intentId: 'cm3intent1' })),
    ).toEqual({ kind: 'pending', intentId: 'cm3intent1' });
    expect(
      classifyCreateError(server('IDEMPOTENCY_CONFLICT', 409, { intentId: 'cm3intent1' })),
    ).toEqual({ kind: 'conflict', intentId: 'cm3intent1' });
    expect(classifyCreateError(server('TOPUP_ALREADY_PENDING', 409, {}))).toEqual({
      kind: 'failed',
      code: 'TOPUP_ALREADY_PENDING',
    });
  });

  it('422 carries the server’s numbers, 429 the wait, 503 "unavailable"', () => {
    const details = { min: '500000', max: '200000000', step: '100000' };
    expect(classifyCreateError(server('TOPUP_AMOUNT_OUT_OF_RANGE', 422, details))).toEqual({
      kind: 'range',
      details,
    });
    expect(
      classifyCreateError(new ApiError({ status: 429, code: 'RATE_LIMITED', retryAfterSec: 30 })),
    ).toEqual({ kind: 'rate', retryAfterSec: 30 });
    expect(classifyCreateError(server('PAYMENT_METHOD_UNAVAILABLE', 503))).toEqual({
      kind: 'unavailable',
    });
  });

  it('anything else, including no answer, is a failure to press again', () => {
    expect(classifyCreateError(new TypeError('Failed to fetch'))).toEqual({
      kind: 'failed',
      code: 'NETWORK',
    });
    expect(classifyCreateError(server('INTERNAL_ERROR', 500))).toEqual({
      kind: 'failed',
      code: 'INTERNAL_ERROR',
    });
  });
});

describe('rangeMessage', () => {
  const d = { min: '500000', step: '100000' };
  it('without a reason it is the plain range', () => {
    expect(rangeMessage({ ...d, max: '200000000' })).toEqual({
      key: 'range',
      min: '500000',
      max: '200000000',
      step: '100000',
    });
  });

  it('a daily cap: what is left, or "used up" when max < min (even 0), never "too large"', () => {
    expect(rangeMessage({ ...d, max: '0', reason: 'DAILY_LIMIT' })).toEqual({ key: 'dailyDone' });
    expect(rangeMessage({ ...d, max: '700000', reason: 'DAILY_LIMIT' })).toEqual({
      key: 'dailyLeft',
      max: '700000',
    });
    expect(rangeMessage({ ...d, max: '0', reason: 'NEW_ACCOUNT_DAILY_LIMIT' })).toEqual({
      key: 'newAccountDone',
    });
    expect(rangeMessage({ ...d, max: '700000', reason: 'NEW_ACCOUNT_DAILY_LIMIT' })).toEqual({
      key: 'dailyLeft',
      max: '700000',
    });
  });
});

describe('safeFrom / fromQuery', () => {
  it('follows only paths inside the Mini App', () => {
    expect(safeFrom('/tg/products/telegram-stars')).toBe('/tg/products/telegram-stars');
    expect(safeFrom('/tg')).toBe('/tg');
    expect(safeFrom('/tg/products/x?y=1')).toBe('/tg/products/x?y=1');
  });

  it('drops everything else', () => {
    for (const bad of [
      null,
      undefined,
      '',
      'https://evil.example/x',
      '//evil.example',
      '/store',
      '/tgx',
      '/tg/../admin',
      '/tg/%2e%2e//evil.example',
      '/tg/.%2e/x',
      '/tg/%2E%2e/login',
      '/tg/%2f%2fevil.example',
      '/tg/%5cevil',
      '/tg//evil.example',
      '/tg\\evil',
      '/tg/a\nb',
      `/tg/${'a'.repeat(300)}`,
    ]) {
      expect(safeFrom(bad), String(bad)).toBeNull();
    }
  });

  it('fromQuery encodes the path or says nothing', () => {
    expect(fromQuery('/tg/products/x')).toBe('?from=%2Ftg%2Fproducts%2Fx');
    expect(fromQuery(null)).toBe('');
  });
});

describe('intentPollInterval', () => {
  it('5 s while waiting, 30 s while expired (a late transfer), stops when over or after a 404', () => {
    expect(intentPollInterval(undefined, null)).toBe(5000);
    expect(intentPollInterval('PENDING', null)).toBe(5000);
    expect(intentPollInterval('EXPIRED', null)).toBe(30_000);
    expect(intentPollInterval('PAID', null)).toBe(false);
    expect(intentPollInterval('CANCELLED', null)).toBe(false);
    expect(intentPollInterval('PENDING', new ApiError({ status: 404, code: 'NOT_FOUND' }))).toBe(
      false,
    );
  });
});
