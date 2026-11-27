import { describe, expect, it } from 'vitest';
import { RecipientWarningSchema } from '../orders/order-schemas';
import {
  FRAGMENT_PRODUCT_SLUGS,
  PREMIUM_MONTHS,
  fragmentProductKind,
  isPremiumMonths,
} from './fragment-product';
import { RECIPIENT_NOTICES } from './recipient-check';
import { RECIPIENT_NOTICE_WARNINGS, recipientWarningsOf } from './recipient-warnings';

describe('fragmentProductKind (owner Q4: by slug)', () => {
  it('names the two Fragment products by their exact catalog slug', () => {
    expect(FRAGMENT_PRODUCT_SLUGS).toEqual({
      STARS: 'telegram-stars',
      PREMIUM: 'telegram-premium',
    });
    expect(fragmentProductKind('telegram-stars')).toBe('STARS');
    expect(fragmentProductKind('telegram-premium')).toBe('PREMIUM');
  });

  it('any other slug is null, never a guess (no prefix, no case folding, no trimming)', () => {
    for (const slug of [
      '',
      'stars',
      'premium',
      'telegram',
      'Telegram-Premium',
      'telegram-premium ',
      ' telegram-stars',
      'telegram-premium-1',
      'telegram-stars2',
      'ful-prod-abc',
      'pubg-mobile',
    ]) {
      expect(fragmentProductKind(slug)).toBeNull();
    }
  });
});

describe('Premium terms (owner Q4: 3, 6, 12 months only)', () => {
  it('sells 3, 6 and 12 months and nothing else', () => {
    expect([...PREMIUM_MONTHS]).toEqual([3, 6, 12]);
    for (const months of PREMIUM_MONTHS) expect(isPremiumMonths(months)).toBe(true);
    for (const months of [0, 1, 2, 4, 5, 9, 24, -3, 3.5, Number.NaN]) {
      expect(isPremiumMonths(months)).toBe(false);
    }
  });
});

describe('recipient warnings (owner Q3)', () => {
  it('every notice has a valid warning whose message is a warnings.* key', () => {
    for (const notice of RECIPIENT_NOTICES) {
      const warning = RECIPIENT_NOTICE_WARNINGS[notice];
      expect(RecipientWarningSchema.parse(warning)).toEqual(warning);
      expect(warning.code).toBe(notice);
    }
    expect(RECIPIENT_NOTICE_WARNINGS.PREMIUM_EXTENDS).toEqual({
      code: 'PREMIUM_EXTENDS',
      message: 'warnings.premiumExtends',
    });
  });

  it('turns notices into warnings: none -> [], one per distinct notice', () => {
    expect(recipientWarningsOf(undefined)).toEqual([]);
    expect(recipientWarningsOf([])).toEqual([]);
    const one = [{ code: 'PREMIUM_EXTENDS', message: 'warnings.premiumExtends' }];
    expect(recipientWarningsOf(['PREMIUM_EXTENDS'])).toEqual(one);
    expect(recipientWarningsOf(['PREMIUM_EXTENDS', 'PREMIUM_EXTENDS'])).toEqual(one);
  });

  it('hands out copies: a caller cannot change the shared table', () => {
    const [warning] = recipientWarningsOf(['PREMIUM_EXTENDS']);
    expect(warning).not.toBe(RECIPIENT_NOTICE_WARNINGS.PREMIUM_EXTENDS);
  });
});
