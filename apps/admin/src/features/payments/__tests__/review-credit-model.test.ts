import {
  AdminConfirmationBodySchema,
  AdminReviewCreditBodySchema,
  type AdminReviewDetailResponse,
} from '@repo/shared';
import { describe, expect, it } from 'vitest';
import {
  creditBody,
  creditConfirmation,
  creditTarget,
  flagsTransition,
  initialFlagsSeen,
  previewAsks,
  isCreditable,
  retypedCredit,
} from '../review-credit-model';

const otp = { challengeId: 'c'.repeat(32), code: '123456' };

function review(message: Partial<AdminReviewDetailResponse['bankMessage']>, status = 'OPEN') {
  return {
    status,
    bankMessage: { parseStatus: 'PARSED', direction: 'CREDIT', amountTiyin: '7500000', ...message },
  } as AdminReviewDetailResponse;
}

describe('isCreditable (the API’s creditableAmount)', () => {
  it('only an OPEN review of a parsed credit with an amount', () => {
    expect(isCreditable(review({}))).toBe(true);
    expect(isCreditable(review({}, 'RESOLVED'))).toBe(false);
    expect(isCreditable(review({ parseStatus: 'UNRECOGNIZED' }))).toBe(false);
    expect(isCreditable(review({ direction: 'DEBIT' }))).toBe(false);
    expect(isCreditable(review({ amountTiyin: null }))).toBe(false);
  });
});

describe('creditTarget', () => {
  it('names exactly one well-formed target', () => {
    expect(creditTarget('intent', { intentId: ' mkint000005 ', userId: 'x' })).toEqual({
      intentId: 'mkint000005',
    });
    expect(creditTarget('user', { intentId: 'mkint000005', userId: 'mkuser000001' })).toEqual({
      userId: 'mkuser000001',
    });
    expect(creditTarget('user', { intentId: '', userId: 'bad id!' })).toBeNull();
  });
});

describe('credit builder', () => {
  it('the code binds target, flags and the re-typed amount of the body', () => {
    const input = {
      reviewId: 'mkrev000002',
      target: { intentId: 'mkint000005' },
      confirmOverride: true,
      bankVerified: true,
      confirmAmountTiyin: retypedCredit('75 000') ?? '',
    };
    const confirmation = AdminConfirmationBodySchema.parse(creditConfirmation(input));
    const body = AdminReviewCreditBodySchema.parse(
      creditBody(input, { reason: 'Bankda tekshirildi', otp }),
    );
    expect(confirmation).toMatchObject({
      action: 'payments.reviewCredit',
      targetId: 'mkrev000002',
      amountTiyin: '7500000',
      intentId: body.intentId,
      confirmOverride: body.confirmOverride,
      bankVerified: body.bankVerified,
    });
    expect(body.confirmAmountTiyin).toBe('7500000');
    expect(body.otp).toEqual(otp);
  });
});

describe('flagsTransition (the ticks belong to one target and one preview, CR-1 / R-5)', () => {
  const asks = (overrideNeeded: string | null, needsBankVerification: boolean) =>
    previewAsks({ overrideNeeded, needsBankVerification });

  it('another target clears the ticks', () => {
    const step = flagsTransition(
      { target: 'intent:a', content: asks(null, true) },
      'intent:b',
      null,
    );
    expect(step).toEqual({ seen: { target: 'intent:b', content: null }, reset: true });
  });

  it('the same target with a preview asking for something else clears them', () => {
    const seen = { target: 'intent:a', content: asks(null, true) };
    expect(flagsTransition(seen, 'intent:a', asks('USER_BLOCKED', true))?.reset).toBe(true);
    expect(flagsTransition(seen, 'intent:a', asks(null, false))?.reset).toBe(true);
  });

  it('the same preview, a loading gap, or the first preview after opening clears nothing', () => {
    const seen = { target: 'intent:a', content: asks(null, true) };
    expect(flagsTransition(seen, 'intent:a', asks(null, true))).toBeNull();
    expect(flagsTransition(seen, 'intent:a', null)).toBeNull();
    const first = flagsTransition(
      { target: 'intent:a', content: null },
      'intent:a',
      asks(null, true),
    );
    expect(first?.reset).toBe(false);
  });

  it('a refill starts from the preview the ticks were sent for: another one clears them (N-3)', () => {
    const sent = {
      target: 'intent',
      override: true,
      bankVerified: true,
      asks: asks(null, true) ?? '',
    };
    const seen = initialFlagsSeen('intent:a', sent);
    expect(seen).toEqual({ target: 'intent:a', content: asks(null, true) });
    expect(flagsTransition(seen, 'intent:a', asks('USER_BLOCKED', true))?.reset).toBe(true);
    expect(flagsTransition(seen, 'intent:a', asks(null, true))).toBeNull();
    // Nothing sent (a fresh dialog) or a send before any preview: nothing was seen yet.
    expect(initialFlagsSeen('intent:a', null).content).toBeNull();
    expect(initialFlagsSeen('intent:a', { asks: '' }).content).toBeNull();
  });
});
