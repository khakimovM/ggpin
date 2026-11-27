import { describe, expect, it } from 'vitest';
import {
  MAX_RECIPIENT_NOTICES,
  RECIPIENT_CHECK_TIMEOUT_MS,
  RECIPIENT_NOTICES,
  RECIPIENT_REFUSAL_REASONS,
  RecipientCheckRequestSchema,
  RecipientCheckResultSchema,
} from './recipient-check';

describe('validate-recipient job contract', () => {
  it('waits ten seconds, as docs/04 says', () => {
    expect(RECIPIENT_CHECK_TIMEOUT_MS).toBe(10_000);
  });

  it('the request is a product and an input, with no user: a job cannot address a person', () => {
    const request = { productId: 'prod_1', input: { username: 'aziz_k' } };
    expect(RecipientCheckRequestSchema.safeParse(request).success).toBe(true);
    expect(RecipientCheckRequestSchema.safeParse({ ...request, userId: 'u1' }).success).toBe(false);
    expect(RecipientCheckRequestSchema.safeParse({ productId: 'prod_1' }).success).toBe(false);
  });

  it('the request input has the same bounds as the API body', () => {
    const tooMany = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}`, 'x']));
    for (const input of [{ username: '' }, { username: 'a\u0000b' }, { Bad: 'x' }, tooMany]) {
      expect(RecipientCheckRequestSchema.safeParse({ productId: 'p', input }).success).toBe(false);
    }
  });

  it('answers FOUND with the provider ref and the display name', () => {
    const found = { status: 'FOUND', providerRef: 'x7Gq-2', displayName: 'Aziz' };
    expect(RecipientCheckResultSchema.safeParse(found).success).toBe(true);
    expect(RecipientCheckResultSchema.safeParse({ ...found, providerRef: '' }).success).toBe(false);
    expect(RecipientCheckResultSchema.safeParse({ ...found, displayName: ' ' }).success).toBe(
      false,
    );
    // A name that hides characters (bidi override, zero-width) is not a usable recipient.
    for (const displayName of ['\u202Eevil', 'a\u200Bb', 'a\u2066b']) {
      expect(RecipientCheckResultSchema.safeParse({ ...found, displayName }).success).toBe(false);
    }
    // No photo in phase 5 (Q12): the strict shape refuses it, so it cannot be passed on by mistake.
    expect(
      RecipientCheckResultSchema.safeParse({ ...found, photoUrl: 'https://x.test/a.jpg' }).success,
    ).toBe(false);
  });

  it('answers NOT_FOUND and UNAVAILABLE with nothing else', () => {
    for (const status of ['NOT_FOUND', 'UNAVAILABLE']) {
      expect(RecipientCheckResultSchema.safeParse({ status }).success).toBe(true);
      expect(RecipientCheckResultSchema.safeParse({ status, providerRef: 'x' }).success).toBe(
        false,
      );
    }
    expect(RecipientCheckResultSchema.safeParse({ status: 'MAYBE' }).success).toBe(false);
  });
});

describe('validate-recipient job contract: Premium (phase 6)', () => {
  const found = { status: 'FOUND', providerRef: 'x7Gq-2', displayName: 'Aziz' };

  it('REFUSED carries only a known reason: no handle, no name, nothing else', () => {
    expect(RECIPIENT_REFUSAL_REASONS).toEqual(['HAS_PREMIUM']);
    const refused = { status: 'REFUSED', reason: 'HAS_PREMIUM' };
    expect(RecipientCheckResultSchema.parse(refused)).toEqual(refused);
    for (const bad of [
      { status: 'REFUSED' },
      { status: 'REFUSED', reason: 'KYC' },
      { status: 'REFUSED', reason: 'has_premium' },
      { ...refused, providerRef: 'x7Gq-2' },
      { ...refused, displayName: 'Aziz' },
    ]) {
      expect(RecipientCheckResultSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('FOUND may carry known notices (at most four); unknown ones or more are refused', () => {
    expect(RECIPIENT_NOTICES).toEqual(['PREMIUM_EXTENDS']);
    expect(MAX_RECIPIENT_NOTICES).toBe(4);
    expect(RecipientCheckResultSchema.parse(found)).toEqual(found);
    for (const notices of [[], ['PREMIUM_EXTENDS'], Array<string>(4).fill('PREMIUM_EXTENDS')]) {
      expect(RecipientCheckResultSchema.safeParse({ ...found, notices }).success).toBe(true);
    }
    for (const notices of [
      Array<string>(5).fill('PREMIUM_EXTENDS'),
      ['LOW_STOCK'],
      ['premium_extends'],
      'PREMIUM_EXTENDS',
      null,
    ]) {
      expect(RecipientCheckResultSchema.safeParse({ ...found, notices }).success).toBe(false);
    }
  });

  it('notices belong to FOUND only', () => {
    for (const status of ['NOT_FOUND', 'UNAVAILABLE']) {
      const withNotice = { status, notices: ['PREMIUM_EXTENDS'] };
      expect(RecipientCheckResultSchema.safeParse(withNotice).success).toBe(false);
    }
    const refused = { status: 'REFUSED', reason: 'HAS_PREMIUM', notices: ['PREMIUM_EXTENDS'] };
    expect(RecipientCheckResultSchema.safeParse(refused).success).toBe(false);
  });
});
