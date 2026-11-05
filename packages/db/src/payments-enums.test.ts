import {
  BANK_DIRECTIONS,
  BANK_FEED_SOURCES,
  BANK_OUTCOMES,
  BANK_PARSE_STATUSES,
  CARD_BANKS,
  CHAIN_STATUSES,
  INTENT_STATUSES,
  PAYMENT_REVIEW_RESOLUTIONS,
  PAYMENT_REVIEW_STATUSES,
  REVIEW_KINDS,
  TOPUP_CARD_STATUSES,
  TOPUP_PROVIDER,
} from '@repo/shared';
import { describe, expect, it } from 'vitest';
import {
  BankDirection,
  BankFeedSource,
  BankOutcome,
  BankParseStatus,
  CardBank,
  ChainStatus,
  IntentStatus,
  PaymentProviderCode,
  PaymentReviewKind,
  PaymentReviewResolution,
  PaymentReviewStatus,
  TopupCardStatus,
} from './index.js';

// The worker writes these values, the API reads them, and the shared lists drive validation and
// alerts. A Prisma enum that drifts from its list would fail only at runtime, on a real bank
// message, so the two are compared here. Sets (sorted): the order of members carries no meaning.
const sorted = (values: readonly string[]): string[] => [...values].sort();

describe('Prisma enums equal the shared lists (phase 4 bank feed)', () => {
  const pairs: [string, object, readonly string[]][] = [
    ['CardBank', CardBank, CARD_BANKS],
    ['TopupCardStatus', TopupCardStatus, TOPUP_CARD_STATUSES],
    ['BankFeedSource', BankFeedSource, BANK_FEED_SOURCES],
    ['BankParseStatus', BankParseStatus, BANK_PARSE_STATUSES],
    ['BankDirection', BankDirection, BANK_DIRECTIONS],
    ['ChainStatus', ChainStatus, CHAIN_STATUSES],
    ['BankOutcome', BankOutcome, BANK_OUTCOMES],
    ['PaymentReviewKind', PaymentReviewKind, REVIEW_KINDS],
    ['PaymentReviewStatus', PaymentReviewStatus, PAYMENT_REVIEW_STATUSES],
    ['PaymentReviewResolution', PaymentReviewResolution, PAYMENT_REVIEW_RESOLUTIONS],
    ['IntentStatus', IntentStatus, INTENT_STATUSES],
  ];

  it.each(pairs)('%s', (_name, prismaEnum, list) => {
    expect(sorted(Object.values(prismaEnum))).toEqual(sorted(list));
  });

  it('PaymentProviderCode contains the P2P provider code', () => {
    expect(Object.values(PaymentProviderCode)).toContain(TOPUP_PROVIDER);
  });
});
