import type { RecipientCheckResult } from '@repo/shared';
import type { FulfillmentAdapter } from '../../adapters/fulfillment-adapter';
import { stubAdapter } from '../../recipients/__tests__/recipient-test-doubles';
import {
  RECHECKED_REF_KEY,
  RECHECK_CLOCK_TOLERANCE_MS,
  RECHECK_MAX_AGE_MS,
  RecipientRecheckError,
  attemptProviderRef,
  comparableName,
  inputOf,
  recipientFor,
} from '../fulfill-recipient';

// Whose handle an attempt uses (S7, CR #2): no re-check for the issuer, a re-check for any other
// adapter, fail-closed on everything but a clear answer.

const PRODUCT = { id: 'p1', slug: 'stars' };
const FIELDS = { username: 'aziz_k', displayName: 'Aziz K' };

function reseller(answer: () => Promise<unknown>) {
  const validate = jest.fn(answer);
  return { adapter: stubAdapter('RESELLER_STARS', { validate }), validate };
}

const found = (displayName = 'Aziz K'): RecipientCheckResult => ({
  status: 'FOUND',
  providerRef: 'r-77',
  displayName,
});

describe('recipientFor', () => {
  it('the issuer itself compares its own handle: no provider call', async () => {
    const { adapter, validate } = reseller(() => Promise.resolve(found()));
    const stored = { fields: FIELDS, confirmedAt: new Date(), providerRef: 'RESELLER_STARS:r-1' };
    await expect(recipientFor(adapter, PRODUCT, stored)).resolves.toEqual({
      kind: 'USE',
      providerRef: 'r-1',
      recheckedRef: null,
    });
    expect(validate).not.toHaveBeenCalled();
  });

  it('a handle without a namespace is used unchanged, as before S7', async () => {
    const { adapter, validate } = reseller(() => Promise.resolve(found()));
    const stored = { fields: FIELDS, confirmedAt: new Date(), providerRef: 'sim_aziz_k' };
    await expect(recipientFor(adapter, PRODUCT, stored)).resolves.toMatchObject({
      providerRef: 'sim_aziz_k',
    });
    expect(validate).not.toHaveBeenCalled();
  });

  it('another issuer: re-checked with the typed input only; FOUND + same name -> its handle', async () => {
    const { adapter, validate } = reseller(() => Promise.resolve(found(' Aziz K ')));
    const stored = { fields: FIELDS, confirmedAt: new Date(), providerRef: 'FRAGMENT:f-1' };
    await expect(recipientFor(adapter, PRODUCT, stored)).resolves.toEqual({
      kind: 'USE',
      providerRef: 'r-77',
      recheckedRef: 'RESELLER_STARS:r-77',
    });
    expect(validate).toHaveBeenCalledWith(PRODUCT, { username: 'aziz_k' }, expect.any(AbortSignal));
  });

  it.each([
    ['NOT_FOUND', { status: 'NOT_FOUND' }],
    ['another display name', found('Somebody Else')],
  ])('another issuer answering %s: RECIPIENT_CHANGED', async (_what, answer) => {
    const { adapter } = reseller(() => Promise.resolve(answer));
    const stored = { fields: FIELDS, confirmedAt: new Date(), providerRef: 'FRAGMENT:f-1' };
    await expect(recipientFor(adapter, PRODUCT, stored)).resolves.toEqual({ kind: 'CHANGED' });
  });

  it.each([
    ['UNAVAILABLE', () => Promise.resolve({ status: 'UNAVAILABLE' }), 'UNAVAILABLE'],
    ['a throw', () => Promise.reject(new Error('down')), 'UNAVAILABLE'],
    ['a bad answer', () => Promise.resolve({ status: 'FOUND' }), 'BAD_ANSWER'],
    [
      'a handle too long to namespace',
      () => Promise.resolve({ ...found(), providerRef: 'r'.repeat(250) }),
      'BAD_ANSWER',
    ],
  ])(
    'another issuer answering %s: a throw (retry, never paid unchecked)',
    async (_w, answer, reason) => {
      const { adapter } = reseller(answer);
      const stored = { fields: FIELDS, confirmedAt: new Date(), providerRef: 'FRAGMENT:f-1' };
      await expect(recipientFor(adapter, PRODUCT, stored)).rejects.toEqual(
        new RecipientRecheckError(reason as 'UNAVAILABLE'),
      );
    },
  );

  it('a hanging re-check ends at the timeout and its signal is aborted', async () => {
    let seen: AbortSignal | undefined;
    const adapter: FulfillmentAdapter = stubAdapter('RESELLER_STARS', {
      validate: (_p, _i, signal) => {
        seen = signal;
        return new Promise(() => undefined);
      },
    });
    const stored = { fields: FIELDS, confirmedAt: new Date(), providerRef: 'FRAGMENT:f-1' };
    await expect(recipientFor(adapter, PRODUCT, stored, { timeoutMs: 50 })).rejects.toEqual(
      new RecipientRecheckError('TIMEOUT'),
    );
    expect(seen?.aborted).toBe(true);
  });

  it('m3: names compare after NFC, trimming and collapsing inner whitespace, nothing more', async () => {
    const decomposed = 'Aziz Ko\u0308k'; // o + combining diaeresis
    expect(comparableName(decomposed)).toBe(comparableName('Aziz K\u00f6k'));
    expect(comparableName(' Aziz \t\u00a0 K ')).toBe('Aziz K');
    expect(comparableName('Aziz K')).not.toBe(comparableName('aziz k'));
    const { adapter } = reseller(() => Promise.resolve(found('Aziz   K')));
    const stored = { fields: FIELDS, confirmedAt: new Date(), providerRef: 'FRAGMENT:f-1' };
    await expect(recipientFor(adapter, PRODUCT, stored)).resolves.toMatchObject({ kind: 'USE' });
  });

  it('L-1: a confirmation older than RECHECK_MAX_AGE_MS is STALE: the provider is not asked', async () => {
    expect(RECHECK_MAX_AGE_MS).toBe(30 * 60_000);
    const now = new Date('2026-11-15T12:00:00Z');
    const at = (ageMs: number) => new Date(now.getTime() - ageMs);
    const { adapter, validate } = reseller(() => Promise.resolve(found()));
    const old = {
      fields: FIELDS,
      confirmedAt: at(RECHECK_MAX_AGE_MS + 1),
      providerRef: 'FRAGMENT:f-1',
    };
    await expect(recipientFor(adapter, PRODUCT, old, { now })).resolves.toEqual({ kind: 'STALE' });
    expect(validate).not.toHaveBeenCalled();
    // Exactly at the limit it is still fresh: re-checked.
    const edge = { ...old, confirmedAt: at(RECHECK_MAX_AGE_MS) };
    await expect(recipientFor(adapter, PRODUCT, edge, { now })).resolves.toMatchObject({
      kind: 'USE',
      recheckedRef: 'RESELLER_STARS:r-77',
    });
    // The issuer compares its own handle: no name match involved, so age does not matter.
    const own = { ...old, providerRef: 'RESELLER_STARS:r-1' };
    await expect(recipientFor(adapter, PRODUCT, own, { now })).resolves.toMatchObject({
      kind: 'USE',
      providerRef: 'r-1',
    });
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('N-2: an order stamped in the worker future beyond the clock tolerance is STALE', async () => {
    expect(RECHECK_CLOCK_TOLERANCE_MS).toBe(5 * 60_000);
    const now = new Date('2026-11-15T12:00:00Z');
    const ahead = (minutes: number) => ({
      fields: FIELDS,
      confirmedAt: new Date(now.getTime() + minutes * 60_000),
      providerRef: 'FRAGMENT:f-1',
    });
    const { adapter, validate } = reseller(() => Promise.resolve(found()));
    await expect(recipientFor(adapter, PRODUCT, ahead(4), { now })).resolves.toMatchObject({
      kind: 'USE',
    });
    await expect(recipientFor(adapter, PRODUCT, ahead(6), { now })).resolves.toEqual({
      kind: 'STALE',
    });
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('inputOf keeps what the customer typed, not what we resolved', () => {
    expect(inputOf({ username: 'a', displayName: 'A', photoUrl: 'https://x.test/p' })).toEqual({
      username: 'a',
    });
  });
});

describe('attemptProviderRef (the follow path)', () => {
  it('issuer = attempt adapter -> its own handle; else the handle kept by the re-check', () => {
    expect(attemptProviderRef('RESELLER_STARS:r-1', 'RESELLER_STARS', {})).toBe('r-1');
    const request = { [RECHECKED_REF_KEY]: 'RESELLER_STARS:r-77' };
    expect(attemptProviderRef('FRAGMENT:f-1', 'RESELLER_STARS', request)).toBe('r-77');
    expect(attemptProviderRef('FRAGMENT:f-1', 'RESELLER_STARS', null)).toBe('FRAGMENT:f-1');
    expect(attemptProviderRef('sim_x', 'RESELLER_STARS', request)).toBe('sim_x');
    expect(attemptProviderRef(null, 'RESELLER_STARS', request)).toBeNull();
  });
});
