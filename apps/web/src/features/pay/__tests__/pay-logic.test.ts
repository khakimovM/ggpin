import type { PayView } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../lib/api/errors';
import { cardGroups } from '../PayCardBlock';
import { splitTail } from '../PayAmount';
import { mmss } from '../PayCountdown';
import { payLocaleFromEntries, payLocaleOf } from '../pay-locale';
import { isStale, payScreenOf } from '../pay-state';
import { payPollInterval } from '../use-pay-view';

const view = (over: Partial<PayView> = {}): PayView => ({
  intentId: 'cm3intent00000000000000001',
  status: 'PENDING',
  baseAmountTiyin: '5000000',
  payAmountTiyin: '5034700',
  card: { bank: 'HUMO', number: '9860123456789012', holderName: 'ALISHER K.' },
  expiresAt: '2026-11-08T12:30:00.000Z',
  ownerHint: 'S***r',
  currency: 'UZS',
  ...over,
});
const notFound = new ApiError({ status: 404, code: 'NOT_FOUND', fromServer: true });
const down = new ApiError({ status: 503, code: 'INTERNAL_ERROR', fromServer: true });
const base = { token: 'tok', data: undefined, error: null, msLeft: 60_000 } as const;

describe('payScreenOf', () => {
  it('waits for hydration, then reads the token', () => {
    expect(payScreenOf({ ...base, token: undefined })).toBe('loading');
    expect(payScreenOf({ ...base, token: null })).toBe('invalid');
  });

  it('loading until the first answer; a 404 is "invalid"; another failure is "failed"', () => {
    expect(payScreenOf(base)).toBe('loading');
    expect(payScreenOf({ ...base, error: notFound })).toBe('invalid');
    expect(payScreenOf({ ...base, error: down })).toBe('failed');
  });

  it('an answer that says the request ended stands even after the token was erased', () => {
    expect(payScreenOf({ ...base, token: null, data: view({ status: 'PAID', card: null }) })).toBe(
      'credited',
    );
    expect(
      payScreenOf({ ...base, token: null, data: view({ status: 'CANCELLED', card: null }) }),
    ).toBe('cancelled');
    // Still waiting on paper but the token is gone: not "pay" any more.
    expect(payScreenOf({ ...base, token: null, data: view() })).toBe('invalid');
    expect(payScreenOf({ ...base, token: null, data: view(), msLeft: 0 })).toBe('expired');
  });

  it('a finished request on record turns "invalid" into the neutral "done" screen, and only then', () => {
    expect(payScreenOf({ ...base, token: null, done: true })).toBe('done');
    expect(payScreenOf({ ...base, token: null, error: notFound, done: true })).toBe('done');
    expect(payScreenOf({ ...base, token: null, done: false })).toBe('invalid');
    // An answer in hand always wins over the marker.
    expect(
      payScreenOf({ ...base, token: null, done: true, data: view({ status: 'PAID', card: null }) }),
    ).toBe('credited');
  });

  it('the status decides: credited, cancelled, expired, waiting', () => {
    expect(payScreenOf({ ...base, data: view({ status: 'PAID', card: null }) })).toBe('credited');
    expect(payScreenOf({ ...base, data: view({ status: 'CANCELLED', card: null }) })).toBe(
      'cancelled',
    );
    expect(payScreenOf({ ...base, data: view({ status: 'EXPIRED', card: null }) })).toBe('expired');
    expect(payScreenOf({ ...base, data: view() })).toBe('pay');
  });

  it('a waiting request whose time is up reads "expired" on this device’s clock', () => {
    expect(payScreenOf({ ...base, data: view(), msLeft: 0 })).toBe('expired');
  });

  it('a token that dies (404) reads "expired" after expiresAt and "invalid" before it', () => {
    expect(payScreenOf({ ...base, data: view(), error: notFound, msLeft: 0 })).toBe('expired');
    expect(payScreenOf({ ...base, data: view(), error: notFound, msLeft: 90_000 })).toBe('invalid');
    // A flaky network keeps the last good answer on screen.
    expect(payScreenOf({ ...base, data: view(), error: down })).toBe('pay');
  });
});

describe('isStale', () => {
  it('only a failed poll after a good answer, and not a 404', () => {
    expect(isStale(undefined, down)).toBe(false);
    expect(isStale(view(), null)).toBe(false);
    expect(isStale(view(), notFound)).toBe(false);
    expect(isStale(view(), down)).toBe(true);
  });
});

describe('payPollInterval', () => {
  it('every 5 s while waiting, also after a failed poll; never when over or after a 404', () => {
    expect(payPollInterval(undefined, null)).toBe(5000);
    expect(payPollInterval('PENDING', null)).toBe(5000);
    expect(payPollInterval('PENDING', down)).toBe(5000);
    for (const status of ['PAID', 'EXPIRED', 'CANCELLED'] as const) {
      expect(payPollInterval(status, null)).toBe(false);
    }
    expect(payPollInterval('PENDING', notFound)).toBe(false);
  });
});

describe('small formatters', () => {
  it('mmss rounds up and never goes negative', () => {
    expect(mmss(29 * 60_000 + 41_000)).toBe('29:41');
    expect(mmss(59_001)).toBe('1:00');
    expect(mmss(0)).toBe('0:00');
    expect(mmss(-5000)).toBe('0:00');
  });

  it('splitTail separates the three digits that identify the payment', () => {
    expect(splitTail('50 347')).toEqual({ head: '50 ', tail: '347' });
    expect(splitTail('347')).toEqual({ head: '', tail: '347' });
    expect(splitTail('so‘m')).toEqual({ head: 'so‘m', tail: '' });
  });

  it('cardGroups cuts a card number into fours', () => {
    expect(cardGroups('9860123456789012')).toEqual(['9860', '1234', '5678', '9012']);
    expect(cardGroups('')).toEqual([]);
  });
});

describe('payLocaleOf', () => {
  it('?locale=ru is Russian; anything else is Uzbek', () => {
    expect(payLocaleOf({ locale: 'ru' })).toBe('ru');
    expect(payLocaleOf({ locale: 'uz' })).toBe('uz');
    expect(payLocaleOf({})).toBe('uz');
    expect(payLocaleOf({ locale: 'en' })).toBe('uz');
    expect(payLocaleOf({ locale: ['ru', 'uz'] })).toBe('uz');
    expect(payLocaleOf({ locale: 'ru', t: 'x' })).toBe('uz');
  });

  it('the middleware and the page agree on every spelling of the query', () => {
    // `?locale=ru&` and `?locale=%72u` decode to one parameter, `locale=ru`.
    for (const [search, expected] of [
      ['?locale=ru', 'ru'],
      ['?locale=ru&', 'ru'],
      ['?locale=%72u', 'ru'],
      ['?locale=uz', 'uz'],
      ['?locale=RU', 'uz'],
      ['?locale=ru&locale=uz', 'uz'],
      ['?locale=ru&x=1', 'uz'],
      ['?x=1', 'uz'],
      ['', 'uz'],
    ] as const) {
      const params = new URLSearchParams(search);
      const fromMiddleware = payLocaleFromEntries([...params.entries()]);
      const record: Record<string, string | string[]> = {};
      for (const key of new Set(params.keys())) {
        const all = params.getAll(key);
        record[key] = all.length === 1 ? (all[0] ?? '') : all;
      }
      expect(fromMiddleware, search).toBe(expected);
      expect(payLocaleOf(record), search).toBe(expected);
    }
  });
});
