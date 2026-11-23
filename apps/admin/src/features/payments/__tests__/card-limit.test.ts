import { AdminCardLimitBodySchema, AdminConfirmationBodySchema } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { limitBody, limitConfirmation, limitInput, lowersLimit } from '../card-limit-model';

const card = {
  id: 'mkcard000001',
  receiveLimitTiyin: '50000000000',
  monthlyLimitTiyin: '30000000000' as string | null,
};

describe('lowersLimit (bigint, same rule as the API)', () => {
  it('a smaller receive limit lowers', () => {
    expect(
      lowersLimit(card, { receiveLimitTiyin: '49999999999', monthlyLimitTiyin: undefined }),
    ).toBe(true);
  });
  it('a larger or equal one does not', () => {
    expect(
      lowersLimit(card, { receiveLimitTiyin: '50000000000', monthlyLimitTiyin: undefined }),
    ).toBe(false);
    expect(
      lowersLimit(card, { receiveLimitTiyin: '90000000000', monthlyLimitTiyin: '30000000000' }),
    ).toBe(false);
  });
  it('a smaller monthly cap lowers, removing it does not', () => {
    expect(lowersLimit(card, { receiveLimitTiyin: '50000000000', monthlyLimitTiyin: '1' })).toBe(
      true,
    );
    expect(lowersLimit(card, { receiveLimitTiyin: '50000000000', monthlyLimitTiyin: null })).toBe(
      false,
    );
  });
  it('setting a monthly cap where there was none lowers', () => {
    const open = { ...card, monthlyLimitTiyin: null };
    expect(
      lowersLimit(open, { receiveLimitTiyin: '50000000000', monthlyLimitTiyin: '900000000000' }),
    ).toBe(true);
  });
  it('compares past Number precision', () => {
    const huge = { ...card, receiveLimitTiyin: '9007199254740993' };
    expect(
      lowersLimit(huge, { receiveLimitTiyin: '9007199254740992', monthlyLimitTiyin: undefined }),
    ).toBe(true);
  });
});

describe('limitInput and the builder', () => {
  it('turns the typed so‘m into tiyin; empty monthly keeps, the checkbox removes', () => {
    expect(limitInput(card, { receive: '500 000 000', monthly: '', removeMonthly: false })).toEqual(
      {
        cardId: card.id,
        receiveLimitTiyin: '50000000000',
        monthlyLimitTiyin: undefined,
      },
    );
    expect(
      limitInput(card, { receive: '1', monthly: '5', removeMonthly: true })?.monthlyLimitTiyin,
    ).toBeNull();
    expect(limitInput(card, { receive: 'x', monthly: '', removeMonthly: false })).toBeNull();
  });

  it('the code is bound to the limits that are sent', () => {
    const input = { cardId: card.id, receiveLimitTiyin: '100', monthlyLimitTiyin: null };
    const confirmation = AdminConfirmationBodySchema.parse(limitConfirmation(input));
    const body = AdminCardLimitBodySchema.parse(
      limitBody(input, {
        reason: 'Limit pasaytirildi',
        otp: { challengeId: 'c'.repeat(32), code: '123456' },
      }),
    );
    expect(confirmation).toMatchObject({
      action: 'cards.limit',
      targetId: card.id,
      receiveLimitTiyin: body.receiveLimitTiyin,
      monthlyLimitTiyin: body.monthlyLimitTiyin,
    });
  });
});
